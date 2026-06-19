import type { Env } from '../env.ts'
import type { RunEvent } from '../db.ts'
import { artifactKey, readArtifactLog } from '../artifacts.ts'

// One Durable Object per PR: the coordination point between the PR's box and
// the rest of the system. It terminates the box's single outbound WebSocket
// (hibernation API, so an idle connected box costs nothing), queues commands
// and run dispatches while no box is connected, and — the point of this class —
// **owns the PR's event log** in its own SQLite. The box's events land in the
// `log` table; the live fan-out and replay-on-connect both read from there, and
// at end of run the log is flushed to a per-run R2 `.jsonl` archive. D1 never
// holds log lines (see docs/architecture.md, "The log and its projections").
//
// The log carries every run for this PR. (run_id, seq) is the box's per-run
// sequence — UNIQUE, the resend idempotency key, a fact the box asserts. `id` is
// a per-object autoincrement: the log's own record of receive-order, the
// PR-global position the PR viewer (/pr-viewer-connect) streams and resumes on,
// with run_id as the channel discriminator. A subscriber tails the log, not the
// fact-stream — events arrive in
// the order the DO logged them (frozen once minted), not necessarily as they
// happened; deterministic and replayable, so multi-box ordering needn't be
// reasoned about.
//
// At teardown the SQLite is reset (POST /reset: DELETE, keeping the autoincrement
// high-water mark), but runs survive in R2 with their `id`, so rehydrateArchived
// folds a run back UNDER ITS ORIGINAL id — same stream whatever the restore order.
//
// Box-channel wire format — OUR contract between worker and box bootstrap,
// wrapping (not extending) the published protocol:
//   box → cloud: { kind: 'events', runId, events: [{ seq, payload }] }
//     — same shape as the HTTP ingest body plus runId; payloads stay opaque
//       (envelope-grade checks only, so newer event types relay through).
//   cloud → box: { kind: 'command', runId?, command } (a protocol Command;
//                  runId present only when the command targets a run)
//                { kind: 'dispatch', run }              (a RunSpec batch)
//                { kind: 'update', update }             (checkout + run
//                  pipeline stages: { headSha, vector, stages: [{name,run}] })
//
// Viewer-channel wire format (WS, cookie-authed at the worker edge):
//   cloud → viewer: { kind: 'event', id, runId, seq, payload }
//     `id` is the PR-global position (cursor + the client collection's key),
//     run_id the channel discriminator, seq the box's per-run sequence, and
//     payload the raw JSON string. Client JSON.parse(frame.payload)s to recover
//     the protocol event, and dedupes the replay/live overlap on id.
//
// Internal HTTP surface (reachable only via the binding, never publicly):
//   GET  /box-connect?boxId=…              — WebSocket upgrade for the box
//   GET  /pr-viewer-connect?sinceId=…       — WebSocket upgrade, whole PR
//   GET  /jsonl?runId=…                    — the run's log as .jsonl text
//   POST /archive                          — { runId } → flush log to R2
//   POST /reset                            — drop live log rows (PR teardown)
//   POST /command                          — { runId?, command } → send or queue
//   POST /dispatch                         — { run: RunSpec } → send or queue
//   POST /retire                           — { boxId } → close sockets, drop queue
//   POST /ingest/:runId                    — { events } → ingestAndFanout

interface EventsEnvelope {
  kind: 'events'
  runId: string
  events: RunEvent[]
}

// A stored log row, as returned by the ingest RETURNING clause: `id` is the
// PR-global position, `seq` the box's per-run sequence, `payload` the JSON
// string as stored.
interface StoredEvent {
  id: number
  seq: number
  payload: string
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
    // The PR's whole event log. `id` is a per-object (= per-PR) autoincrement —
    // the single PR-global position the PR-anchored viewer streams/resumes on.
    // (run_id, seq) stays UNIQUE: the box's per-run sequence, the resend
    // idempotency key (INSERT OR IGNORE), and in parity with the box's .jsonl.
    this.sql = state.storage.sql
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS log (
         id      INTEGER PRIMARY KEY AUTOINCREMENT,
         run_id  TEXT    NOT NULL,
         seq     INTEGER NOT NULL,
         payload TEXT    NOT NULL,
         ts      INTEGER NOT NULL,
         UNIQUE (run_id, seq)
       )`,
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

    if (url.pathname === '/pr-viewer-connect') {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 })
      }
      // Whole-PR stream: no run filter, just a resume cursor over the PR-global
      // id. repo + pr (the DO stores no identity) let rehydrate find the PR's
      // archived runs in D1.
      let sinceId = parseInt(url.searchParams.get('sinceId') ?? '0', 10)
      if (!Number.isFinite(sinceId) || sinceId < 0) sinceId = 0
      const repo = url.searchParams.get('repo')
      const prNumber = parseInt(url.searchParams.get('pr') ?? '', 10)

      // Fold archived/reset runs back in BEFORE registering for live fan-out:
      // rehydrate awaits (D1 + R2), and any live frame delivered during that
      // await would land ahead of the not-yet-sent replay, jumping the client's
      // id cursor past — and so dropping — the unreplayed lower ids. Those
      // events are in the log regardless, so replay (after register) still
      // covers them. Register THEN replay runs without an await between, so no
      // live frame can interleave ahead of the replay.
      if (repo && Number.isFinite(prNumber)) await this.rehydrateArchived(repo, prNumber)
      const pair = new WebSocketPair()
      this.state.acceptWebSocket(pair[1]!, ['viewer', 'prv'])
      await this.replayPrTo(pair[1]!, sinceId)
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

    if (url.pathname === '/reset' && req.method === 'POST') {
      // PR teardown. DELETE, not DROP: keeping the autoincrement high-water mark
      // means a later re-fold slots archived rows back under their original ids
      // while ids for post-revival runs climb above — the two never collide.
      this.sql.exec('DELETE FROM log')
      return Response.json({ ok: true })
    }

    if (url.pathname === '/command' && req.method === 'POST') {
      // runId is optional: it targets the box's per-run bookkeeping when a
      // command names a run, and is absent for run-agnostic commands. JSON
      // drops an undefined key, so the box sees runId only when one was sent.
      const { runId, command } = (await req.json()) as { runId?: string; command: unknown }
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
    // INSERT OR IGNORE: a box reconnect can replay events it already sent;
    // (run_id, seq) is the dedup key, so re-delivery is a no-op. RETURNING
    // yields a row only for an actually-inserted event, each carrying its `id`
    // (the PR-global position) — so PR fan-out never duplicates.
    const inserted: StoredEvent[] = []
    for (const e of events) {
      const row = this.sql
        .exec(
          'INSERT OR IGNORE INTO log (run_id, seq, payload, ts) VALUES (?, ?, ?, ?) RETURNING id, seq, payload',
          runId,
          e.seq,
          JSON.stringify(e.payload ?? null),
          now,
        )
        .toArray()[0] as StoredEvent | undefined
      if (row) inserted.push(row)
    }
    this.fanoutPr(runId, inserted)
  }

  // Fan live events to PR viewers (every viewer of this object — one DO is one
  // PR). The frame carries the PR-global `id` (cursor + client collection key),
  // run_id (channel discriminator) and the per-run seq; payload is the stored
  // JSON string so live and replay frames are byte-identical.
  private fanoutPr(runId: string, events: StoredEvent[]): void {
    const sockets = this.state.getWebSockets('prv')
    if (sockets.length === 0) return
    for (const e of events) {
      const frame = JSON.stringify({ kind: 'event', id: e.id, runId, seq: e.seq, payload: e.payload })
      for (const ws of sockets) {
        try { ws.send(frame) } catch { /* socket closing; nothing to do */ }
      }
    }
  }

  // Fold this PR's archived runs back into the log under their original ids, so
  // the PR stream is the whole history even after a teardown reset. Restored id
  // (not reassigned) means restore order is irrelevant — ORDER BY id rebuilds
  // the same stream. D1 names the PR's runs (passed in; the DO stores no id).
  private async rehydrateArchived(repo: string, prNumber: number): Promise<void> {
    if (!this.env.ARTIFACTS) return
    const runs = await this.env.DB.prepare(
      `SELECT id AS run_id, artifact_key FROM runs
         WHERE repo = ?1 AND pr_number = ?2 AND artifact_key IS NOT NULL
         ORDER BY started_at ASC`,
    )
      .bind(repo, prNumber)
      .all<{ run_id: string; artifact_key: string }>()
    for (const run of runs.results ?? []) {
      // Already live or folded in: skip the R2 read (the insert would no-op).
      const present = this.sql.exec('SELECT 1 FROM log WHERE run_id = ? LIMIT 1', run.run_id).toArray()
      if (present.length > 0) continue
      for (const row of await readArtifactLog(this.env, run.artifact_key)) {
        if (row.id == null) continue // pre-id archive: can't be slotted in order
        this.sql.exec(
          'INSERT OR IGNORE INTO log (id, run_id, seq, payload, ts) VALUES (?, ?, ?, ?, ?)',
          row.id,
          run.run_id,
          row.seq,
          row.payload,
          row.ts ?? 0,
        )
      }
    }
  }

  // Replay the whole PR's log to a PR viewer, ordered by the PR-global `id` (the
  // resume cursor). The object is the PR, so every row qualifies. Pages to keep
  // a long PR out of memory. Archived/reset runs are folded back in by
  // rehydrateArchived before this runs, so they appear here in id order too.
  private async replayPrTo(ws: WebSocket, sinceId: number): Promise<void> {
    let after = sinceId
    for (;;) {
      const rows = this.sql
        .exec(
          'SELECT id, run_id, seq, payload FROM log WHERE id > ? ORDER BY id ASC LIMIT ?',
          after,
          REPLAY_PAGE,
        )
        .toArray() as Array<{ id: number; run_id: string; seq: number; payload: string }>
      for (const row of rows) {
        ws.send(JSON.stringify({ kind: 'event', id: row.id, runId: row.run_id, seq: row.seq, payload: row.payload }))
        after = row.id
      }
      if (rows.length < REPLAY_PAGE) break
    }
  }

  // Serialize a run's slice of the log for R2 — the WHOLE log row per line,
  // `{"id":N,"seq":M,"ts":T,"payload":<payload>}`, so the archive can recreate
  // the log exactly (rehydrateArchived reinserts under the original id). Pages
  // the local SQLite to keep a long run out of memory.
  private buildRunArchive(runId: string): string {
    const lines: string[] = []
    let after = 0
    for (;;) {
      const rows = this.sql
        .exec(
          'SELECT id, seq, ts, payload FROM log WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
          runId,
          after,
          REPLAY_PAGE,
        )
        .toArray() as Array<{ id: number; seq: number; ts: number; payload: string }>
      for (const row of rows) {
        // payload is already a JSON string; embed it raw so we never reparse.
        lines.push(`{"id":${row.id},"seq":${row.seq},"ts":${row.ts},"payload":${row.payload}}`)
        after = row.seq
      }
      if (rows.length < REPLAY_PAGE) break
    }
    return lines.length ? lines.join('\n') + '\n' : ''
  }

  // Build the run's log as the box-compatible .jsonl projection, one event per
  // line as `{"seq":N,"payload":<payload>}` — the /jsonl download view, the same
  // bytes the R2 archive projects to on download (readArtifactBoxJsonl), so the
  // download reads the same live or archived. Pages SQLite to keep a long run
  // out of memory.
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
    await this.env.ARTIFACTS.put(key, this.buildRunArchive(runId), {
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
