import { Server, type Connection, type ConnectionContext } from 'partyserver'
import type { Env } from '../env.ts'
import { insertEvents, type RunEvent } from '../db.ts'
import { getArtifactKey, readArtifactEvents } from '../artifacts.ts'

// One Durable Object per PR: the coordination point between the PR's box and
// the rest of the system. It terminates the box's single outbound WebSocket
// (hibernation API, so an idle connected box costs nothing), queues commands
// and run dispatches while no box is connected, writes the box's events
// through to D1, and fans them out live to connected viewer WebSockets.
//
// SPIKE (partyserver): the connection bookkeeping — accept, hibernate, tag,
// fan out, look up by tag — is delegated to partyserver's `Server`. What it
// does NOT absorb is everything that made this DO ours: the box-vs-viewer
// split, replay-from-D1-then-R2, the persistent command queue, and
// latest-wins connection replacement. Those stay here, which is the point of
// the spike — to see what's framework and what's domain.
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
// Internal HTTP surface (reachable only via the binding, never publicly) —
// unchanged from the hand-rolled version, so no call site moves:
//   GET  /box-connect?boxId=…              — WebSocket upgrade for the box
//   GET  /viewer-connect?runId=…&sinceSeq=… — WebSocket upgrade for viewers
//   POST /command                          — { runId, command } → send or queue
//   POST /dispatch                         — { run: RunSpec } → send or queue
//   POST /update                           — { update } → send or queue
//   POST /retire                           — { boxId } → close sockets, drop queue
//   POST /ingest/:runId                    — { events } → ingestAndFanout

interface EventsEnvelope {
  kind: 'events'
  runId: string
  events: RunEvent[]
}

const QUEUE_PREFIX = 'q:'
const REPLAY_PAGE = 1000

export class PrCoordinator extends Server<Env> {
  // Keep the hibernation property the hand-rolled version had: an idle
  // connected box must cost nothing. partyserver routes hibernated wakes back
  // through onMessage/onClose with the connection (and its tags) rehydrated.
  static override options = { hibernate: true }

  // partyserver calls fetch() for us; non-WS requests land here. This is the
  // old fetch()'s POST arm verbatim — the WS arm moved to onConnect.
  override async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)

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
      for (const c of this.getConnections(boxId)) c.close(1001, 'box retired')
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

  // Tags are assigned once at accept time and survive hibernation, so the
  // box/viewer split and the per-run fan-out group are both expressed here.
  // Auth and the upgrade-header check already happened at the worker edge;
  // boxId/runId arrive as query params we can trust.
  override getConnectionTags(_conn: Connection, ctx: ConnectionContext): string[] {
    const url = new URL(ctx.request.url)
    if (url.pathname === '/box-connect') {
      const boxId = url.searchParams.get('boxId') ?? ''
      return ['box', boxId]
    }
    // viewer
    const runId = url.searchParams.get('runId') ?? ''
    return ['viewer', `v:${runId}`]
  }

  override async onConnect(conn: Connection, ctx: ConnectionContext): Promise<void> {
    const url = new URL(ctx.request.url)

    if (url.pathname === '/box-connect') {
      const boxId = url.searchParams.get('boxId')
      if (!boxId) return void conn.close(1008, 'boxId required')
      // Latest wins extends to connections: at most one live box channel. Close
      // any prior box socket (this new one is already accepted + tagged).
      for (const c of this.getConnections('box')) {
        if (c.id !== conn.id) c.close(1012, 'replaced')
      }
      await this.flushQueue(conn)
      return
    }

    // viewer-connect
    const runId = url.searchParams.get('runId')
    if (!runId) return void conn.close(1008, 'runId required')
    let sinceSeq = parseInt(url.searchParams.get('sinceSeq') ?? '0', 10)
    if (!Number.isFinite(sinceSeq) || sinceSeq < 0) sinceSeq = 0
    // The connection is already accepted + tagged before onConnect runs, so
    // live frames during the replay window reach this socket. Any event
    // delivered twice (live + replay) is deduped by the client on seq.
    await this.replayTo(conn, runId, sinceSeq)
  }

  override async onMessage(conn: Connection, message: string | ArrayBuffer): Promise<void> {
    // Only the box sends; viewers are receive-only. Anything else is a no-op.
    if (typeof message !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(message)
    } catch {
      conn.send(JSON.stringify({ kind: 'error', message: 'not json' }))
      return
    }
    const envelope = parsed as Partial<EventsEnvelope>
    if (envelope.kind !== 'events' || typeof envelope.runId !== 'string' || !Array.isArray(envelope.events)) {
      conn.send(JSON.stringify({ kind: 'error', message: 'unknown envelope' }))
      return
    }
    const events = envelope.events.filter(
      (e): e is RunEvent => e != null && typeof e.seq === 'number',
    )
    await this.ingestAndFanout(envelope.runId, events)
    conn.send(JSON.stringify({ kind: 'ack', runId: envelope.runId, count: events.length }))
  }

  // onClose intentionally omitted: connection state lives in the socket tags,
  // and the queue persists precisely for the box-not-connected case.

  private async ingestAndFanout(runId: string, events: RunEvent[]): Promise<void> {
    if (events.length === 0) return
    await insertEvents(this.env.DB, runId, events)
    this.fanout(runId, events)
  }

  // Fan live events to every viewer registered for this run.
  // payload is re-serialized to a JSON string so replay and live frames are
  // identical on the wire — client calls JSON.parse(frame.payload) for both.
  private fanout(runId: string, events: RunEvent[]): void {
    const sockets = [...this.getConnections(`v:${runId}`)]
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

  // Replay stored events to a single viewer. Pages through D1 to avoid
  // loading an entire long run into memory at once. When a terminal run's
  // events have been pruned from D1 (the cron sweep, after its artifact was
  // written), D1 yields nothing and replay falls back to the R2 artifact —
  // same frame shape, so the viewer can't tell the difference.
  private async replayTo(ws: Connection, runId: string, sinceSeq: number): Promise<void> {
    let after = sinceSeq
    let sawAny = false
    for (;;) {
      const { results } = await this.env.DB.prepare(
        'SELECT seq, payload FROM events WHERE run_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3',
      ).bind(runId, after, REPLAY_PAGE).all<{ seq: number; payload: string }>()
      for (const row of results ?? []) {
        // row.payload is already a JSON string (insertEvents stores JSON.stringify).
        ws.send(JSON.stringify({ kind: 'event', seq: row.seq, payload: row.payload }))
        after = row.seq
        sawAny = true
      }
      if ((results?.length ?? 0) < REPLAY_PAGE) break
    }

    if (sawAny) return
    const key = await getArtifactKey(this.env, runId)
    if (!key) return
    for (const e of await readArtifactEvents(this.env, key, sinceSeq)) {
      ws.send(JSON.stringify({ kind: 'event', seq: e.seq, payload: e.payload }))
    }
  }

  private boxSocket(): Connection | null {
    return [...this.getConnections('box')][0] ?? null
  }

  private async sendOrQueue(message: object): Promise<boolean> {
    const box = this.boxSocket()
    if (box) {
      box.send(JSON.stringify(message))
      return true
    }
    // Keyed by time + entropy so flush order is FIFO-ish and keys never clash.
    await this.ctx.storage.put(
      `${QUEUE_PREFIX}${Date.now().toString().padStart(15, '0')}:${crypto.randomUUID().slice(0, 8)}`,
      message,
    )
    return false
  }

  private async flushQueue(ws: Connection): Promise<void> {
    const queued = await this.ctx.storage.list({ prefix: QUEUE_PREFIX })
    for (const [key, message] of queued) {
      ws.send(JSON.stringify(message))
      await this.ctx.storage.delete(key)
    }
  }

  private async clearQueue(): Promise<void> {
    const queued = await this.ctx.storage.list({ prefix: QUEUE_PREFIX })
    await this.ctx.storage.delete([...queued.keys()])
  }
}

// The DO's name is the PR identity — one coordinator per PR, found by name
// from anywhere in the worker without a lookup table. Unchanged: partyserver
// reads ctx.id.name (set by idFromName) for `this.name`, so a direct
// stub.fetch() to the internal surface still routes correctly.
export function prCoordinator(env: Env, repo: string, prNumber: number): DurableObjectStub {
  return env.PR_COORDINATOR.get(env.PR_COORDINATOR.idFromName(`${repo}#${prNumber}`))
}
