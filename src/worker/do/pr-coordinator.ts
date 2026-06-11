import type { Env } from '../env.ts'
import { insertEvents, type RunEvent } from '../db.ts'

// One Durable Object per PR: the coordination point between the PR's box and
// the rest of the system. It terminates the box's single outbound WebSocket
// (hibernation API, so an idle connected box costs nothing), queues commands
// and run dispatches while no box is connected, and writes the box's events
// through to D1 — where the existing SSE endpoint picks them up for viewers.
// (A direct DO→viewer WebSocket leg can replace that poll later without
// changing the box side.)
//
// Box-channel wire format — OUR contract between worker and box bootstrap,
// wrapping (not extending) the published protocol:
//   box → cloud: { kind: 'events', runId, events: [{ seq, payload }] }
//     — same shape as the HTTP ingest body plus runId; payloads stay opaque
//       (envelope-grade checks only, so newer event types relay through).
//   cloud → box: { kind: 'command', runId, command }   (a protocol Command)
//                { kind: 'dispatch', run }              (a RunSpec batch)
//
// Internal HTTP surface (reachable only via the binding, never publicly):
//   GET  /box-connect?boxId=…  — WebSocket upgrade for the box channel
//   POST /command              — { runId, command } → send or queue
//   POST /dispatch             — { run: RunSpec } → send or queue
//   POST /retire               — { boxId } → close its sockets, drop queue

interface EventsEnvelope {
  kind: 'events'
  runId: string
  events: RunEvent[]
}

const QUEUE_PREFIX = 'q:'

export class PrCoordinator implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

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

    if (url.pathname === '/retire' && req.method === 'POST') {
      const { boxId } = (await req.json()) as { boxId: string }
      for (const ws of this.state.getWebSockets(boxId)) ws.close(1001, 'box retired')
      // Queued work targeted the retired state; the new box gets fresh
      // dispatches from createRun, so stale queue entries would be wrong.
      await this.clearQueue()
      return Response.json({ ok: true })
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
    if (events.length > 0) await insertEvents(this.env.DB, envelope.runId, events)
    ws.send(JSON.stringify({ kind: 'ack', runId: envelope.runId, count: events.length }))
  }

  async webSocketClose(): Promise<void> {
    // Nothing to clean: connection state lives in the socket tags, and the
    // queue persists precisely for the box-not-connected case.
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
