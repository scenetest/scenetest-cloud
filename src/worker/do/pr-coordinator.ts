import type { Env } from '../env.ts'
import type { RunEvent } from '../db.ts'
import { artifactKey, getArtifactKey, readArtifactEvents } from '../artifacts.ts'

// One Durable Object per PR: the coordination point between the PR's box and
// the rest of the system. It terminates the box's single outbound WebSocket
// (hibernation API, so an idle connected box costs nothing), queues commands
// and run dispatches while no box is connected, and — the point of this class —
// **owns the PR's event log** in its own SQLite. The box's events land in the
// `log` table; the live fan-out and replay-on-connect both read from there, and
// at end of run the log is flushed to a per-run R2 `.jsonl` archive. D1 never
// holds log lines (see docs/architecture.md, "The log and its projections").
//
// The log is keyed by (run_id, seq): the box assigns `seq` per run, and that
// is the order the viewer subscribes against today. (A per-PR object-assigned
// cursor and a channel discriminator arrive with the one-collection-per-PR
// dashboard work; this class deliberately keeps the existing per-run wire
// contract.)
//
// Box-channel wire format — OUR contract between worker and box bootstrap,
// wrapping (not extending) the published protocol:
//   box → cloud: { kind: 'events', runId, events: [{ seq, payload }] }
//     — same shape as the HTTP ingest body plus runId; payloads stay opaque
//       (envelope-grade checks only, so newer event types relay through).
//   cloud → box: { kind: 'command', runId, command }   (a protocol Command)
//                { kind: 'dispatch', run }              (a RunSpec batch)
//                { kind: 'update', update }             (checkout + run
//                  pipeline stages: { headSha, vector, stages: [{name,run}] })
//
// Viewer-channel wire format (WS, cookie-authed at the worker edge):
//   cloud → viewer: { kind: 'event', seq, payload }
//     payload is the raw JSON string — same bytes SSE put after `data:`.
//     Client calls JSON.parse(frame.payload) to recover the protocol event.
//     Both live and replay frames use this shape so the client dedupes by seq.
//
// Internal HTTP surface (reachable only via the binding, never publicly):
//   GET  /box-connect?boxId=…              — WebSocket upgrade for the box
//   GET  /viewer-connect?runId=…&sinceSeq=… — WebSocket upgrade for viewers
//   GET  /jsonl?runId=…                    — the run's log as .jsonl text
//   POST /archive                          — { runId } → flush log to R2
//   POST /command                          — { runId, command } → send or queue
//   POST /dispatch                         — { run: RunSpec } → send or queue
//   POST /retire                           — { boxId } → close sockets, drop queue
//   POST /ingest/:runId                    — { events } → ingestAndFanout

interface EventsEnvelope {
  kind: 'events'
  runId: string
  events: RunEvent[]
}

const QUEUE_PREFIX = 'q:'
const REPLAY_PAGE = 1000

export class PrCoordinator implements DurableObject {
  private sql: SqlStorage

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    // SQLite-backed (wrangler new_sqlite_classes). The schema is created on
    // first construction and is a no-op thereafter; the constructor runs
    // before any request is dispatched, so the table is always present.
    this.sql = state.storage.sql
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS log (
         run_id  TEXT    NOT NULL,
         seq     INTEGER NOT NULL,
         payload TEXT    NOT NULL,
         ts      INTEGER NOT NULL,
         PRIMARY KEY (run_id, seq)
       ) WITHOUT ROWID`,
    )
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === '/box-connect') {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 })
      }
      const boxId = url.searchParams.get('boxId')
      if (!boxId) return new Response('boxId required', { status: 400 })

      // Latest wins extends to connections: at most one live box channel.
      for (const ws of this.state.getWebSockets('box')) ws.close(1012, 'replaced')

      const pair = new WebSocketPair()
      this.state.acceptWebSocket(pair[1]!, ['box', boxId])
      await this.flushQueue(pair[1]!)
      return new Response(null, { status: 101, webSocket: pair[0]! })
    }

    if (url.pathname === '/viewer-connect') {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 })
      }
      const runId = url.searchParams.get('runId')
      if (!runId) return new Response('runId required', { status: 400 })
      let sinceSeq = parseInt(url.searchParams.get('sinceSeq') ?? '0', 10)
      if (!Number.isFinite(sinceSeq) || sinceSeq < 0) sinceSeq = 0

      const pair = new WebSocketPair()
      // Register FIRST so live frames during the replay window reach this
      // socket. Any event delivered twice (live + replay) is deduped by the
      // client on seq — no event is ever lost.
      this.state.acceptWebSocket(pair[1]!, ['viewer', `v:${runId}`])
      await this.replayTo(pair[1]!, runId, sinceSeq)
      return new Response(null, { status: 101, webSocket: pair[0]! })
    }

    if (url.pathname === '/jsonl' && req.method === 'GET') {
      const runId = url.searchParams.get('runId')
      if (!runId) return new Response('runId required', { status: 400 })
      return new Response(this.buildRunJsonl(runId), {
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      })
    }

    if (url.pathname === '/archive' && req.method === 'POST') {
      const { runId } = (await req.json()) as { runId: string }
      if (!runId) return new Response('runId required', { status: 400 })
      const key = await this.archiveRun(runId)
      return Response.json({ key })
    }

    if (url.pathname === '/command' && req.method === 'POST') {
      const { runId, command } = (await req.json()) as { runId: string; command: unknown }
      const delivered = await this.sendOrQueue({ kind: 'command', runId, command })
      return Response.json({ delivered })
    }

    if (url.pathname === '/dispatch' && req.method === 'POST') {
      const { run } = (await req.json()) as { run: unknown }
      const delivered = await this.sendOrQueue({ kind: 'dispatch', run })
      return Response.json({ delivered })
    }

    if (url.pathname === '/update' && req.method === 'POST') {
      // Pipeline update: checkout this sha and run these stages, then report
      // ready with the vector. Queued like everything else so a still-booting
      // box receives it first (FIFO), before any dispatches.
      const update = (await req.json()) as unknown
      const delivered = await this.sendOrQueue({ kind: 'update', update })
      return Response.json({ delivered })
    }

    if (url.pathname === '/retire' && req.method === 'POST') {
      const { boxId } = (await req.json()) as { boxId: string }
      for (const ws of this.state.getWebSockets(boxId)) ws.close(1001, 'box retired')
      // Queued work targeted the retired state; the new box gets fresh
      // dispatches from createRun, so stale queue entries would be wrong.
      await this.clearQueue()
      return Response.json({ ok: true })
    }

    if (url.pathname.startsWith('/ingest/') && req.method === 'POST') {
      const runId = decodeURIComponent(url.pathname.slice('/ingest/'.length))
      if (!runId) return new Response('runId required', { status: 400 })
      const { events } = (await req.json()) as { events?: RunEvent[] }
      const valid = (events ?? []).filter(
        (e): e is RunEvent => e != null && typeof e.seq === 'number',
      )
      await this.ingestAndFanout(runId, valid)
      return Response.json({ ok: true, count: valid.length })
    }

    return new Response('Not Found', { status: 404 })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(message)
    } catch {
      ws.send(JSON.stringify({ kind: 'error', message: 'not json' }))
      return
    }
    const envelope = parsed as Partial<EventsEnvelope>
    if (envelope.kind !== 'events' || typeof envelope.runId !== 'string' || !Array.isArray(envelope.events)) {
      ws.send(JSON.stringify({ kind: 'error', message: 'unknown envelope' }))
      return
    }
    const events = envelope.events.filter(
      (e): e is RunEvent => e != null && typeof e.seq === 'number',
    )
    await this.ingestAndFanout(envelope.runId, events)
    ws.send(JSON.stringify({ kind: 'ack', runId: envelope.runId, count: events.length }))
  }

  async webSocketClose(): Promise<void> {
    // Nothing to clean: connection state lives in the socket tags, and the
    // queue persists precisely for the box-not-connected case.
  }

  private async ingestAndFanout(runId: string, events: RunEvent[]): Promise<void> {
    if (events.length === 0) return
    const now = Date.now()
    for (const e of events) {
      // INSERT OR IGNORE: a box reconnect can replay events it already sent;
      // (run_id, seq) is the dedup key, so re-delivery is a no-op.
      this.sql.exec(
        'INSERT OR IGNORE INTO log (run_id, seq, payload, ts) VALUES (?, ?, ?, ?)',
        runId,
        e.seq,
        JSON.stringify(e.payload ?? null),
        now,
      )
    }
    this.fanout(runId, events)
  }

  // Fan live events to every viewer registered for this run.
  // payload is re-serialized to a JSON string so replay and live frames are
  // identical on the wire — client calls JSON.parse(frame.payload) for both.
  private fanout(runId: string, events: RunEvent[]): void {
    const sockets = this.state.getWebSockets(`v:${runId}`)
    if (sockets.length === 0) return
    for (const e of events) {
      const frame = JSON.stringify({
        kind: 'event',
        seq: e.seq,
        payload: JSON.stringify(e.payload ?? null),
      })
      for (const ws of sockets) {
        try { ws.send(frame) } catch { /* socket closing; nothing to do */ }
      }
    }
  }

  // Replay stored events to a single viewer. Pages through the local SQLite to
  // avoid loading an entire long run into memory at once. When the run's log is
  // no longer here (its PR closed and the object was reset after the archive
  // was written), SQLite yields nothing and replay falls back to the R2
  // artifact — same frame shape, so the viewer can't tell the difference.
  private async replayTo(ws: WebSocket, runId: string, sinceSeq: number): Promise<void> {
    let after = sinceSeq
    let sawAny = false
    for (;;) {
      const rows = this.sql
        .exec(
          'SELECT seq, payload FROM log WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
          runId,
          after,
          REPLAY_PAGE,
        )
        .toArray() as Array<{ seq: number; payload: string }>
      for (const row of rows) {
        // row.payload is already a JSON string (ingest stores JSON.stringify).
        ws.send(JSON.stringify({ kind: 'event', seq: row.seq, payload: row.payload }))
        after = row.seq
        sawAny = true
      }
      if (rows.length < REPLAY_PAGE) break
    }

    if (sawAny) return
    const key = await getArtifactKey(this.env, runId)
    if (!key) return
    for (const e of await readArtifactEvents(this.env, key, sinceSeq)) {
      ws.send(JSON.stringify({ kind: 'event', seq: e.seq, payload: e.payload }))
    }
  }

  // Build the run's log as .jsonl, one event per line in the archive format
  // `{"seq":N,"payload":<payload>}` — the same bytes the R2 artifact holds, so
  // the live download and the archived download are byte-identical. Pages the
  // local SQLite to keep a long run out of memory.
  private buildRunJsonl(runId: string): string {
    const lines: string[] = []
    let after = 0
    for (;;) {
      const rows = this.sql
        .exec(
          'SELECT seq, payload FROM log WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
          runId,
          after,
          REPLAY_PAGE,
        )
        .toArray() as Array<{ seq: number; payload: string }>
      for (const row of rows) {
        // row.payload is already a JSON string; embed it raw so we never reparse.
        lines.push(`{"seq":${row.seq},"payload":${row.payload}}`)
        after = row.seq
      }
      if (rows.length < REPLAY_PAGE) break
    }
    return lines.length ? lines.join('\n') + '\n' : ''
  }

  // Flush a run's log to its durable R2 artifact and record the key on the D1
  // `runs` row. Idempotent: a run that already has a key is left alone. No-op
  // without the ARTIFACTS binding. Repo (for the object key) is resolved from
  // D1, the same place the run's metadata projection already lives.
  private async archiveRun(runId: string): Promise<string | null> {
    if (!this.env.ARTIFACTS) return null
    const run = await this.env.DB.prepare('SELECT repo, artifact_key FROM runs WHERE id = ?1')
      .bind(runId)
      .first<{ repo: string; artifact_key: string | null }>()
    if (!run) return null
    if (run.artifact_key) return run.artifact_key

    const key = artifactKey(run.repo, runId)
    await this.env.ARTIFACTS.put(key, this.buildRunJsonl(runId), {
      httpMetadata: { contentType: 'application/x-ndjson' },
    })
    await this.env.DB.prepare('UPDATE runs SET artifact_key = ?1 WHERE id = ?2').bind(key, runId).run()
    return key
  }

  private boxSocket(): WebSocket | null {
    return this.state.getWebSockets('box')[0] ?? null
  }

  private async sendOrQueue(message: object): Promise<boolean> {
    const box = this.boxSocket()
    if (box) {
      box.send(JSON.stringify(message))
      return true
    }
    // Keyed by time + entropy so flush order is FIFO-ish and keys never clash.
    await this.state.storage.put(
      `${QUEUE_PREFIX}${Date.now().toString().padStart(15, '0')}:${crypto.randomUUID().slice(0, 8)}`,
      message,
    )
    return false
  }

  private async flushQueue(ws: WebSocket): Promise<void> {
    const queued = await this.state.storage.list({ prefix: QUEUE_PREFIX })
    for (const [key, message] of queued) {
      ws.send(JSON.stringify(message))
      await this.state.storage.delete(key)
    }
  }

  private async clearQueue(): Promise<void> {
    const queued = await this.state.storage.list({ prefix: QUEUE_PREFIX })
    await this.state.storage.delete([...queued.keys()])
  }
}

// The DO's name is the PR identity — one coordinator per PR, found by name
// from anywhere in the worker without a lookup table.
export function prCoordinator(env: Env, repo: string, prNumber: number): DurableObjectStub {
  return env.PR_COORDINATOR.get(env.PR_COORDINATOR.idFromName(`${repo}#${prNumber}`))
}
