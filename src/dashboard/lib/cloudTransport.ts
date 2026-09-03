import type { ConnectionStatus, Transport } from '@scenetest/dashboard'
import type { RunEvent } from '@scenetest/protocol'
import { isEventShaped } from '@scenetest/protocol'
import { WebSocket as ReconnectingWebSocket } from 'partysocket'

// Transport adapter for cloud: the worker API, session-authed (cookies ride
// along automatically on same-origin WebSocket and fetch).
//
// The PR is the unit — one socket streams every event for the whole PR over the
// viewer frame protocol:
//   { kind: 'event', id: number, runId: string, seq: number, payload: string }
// `id` is the PR-global position (cursor + the client collection's key), runId
// is the channel discriminator, seq is the box's per-run sequence, and payload
// is a JSON string (JSON.parse it to get the protocol event). The client tracks
// the last applied `id` and dedupes any frame at or below it (register-first-
// then-replay can deliver a frame twice). partysocket owns reconnect + backoff
// and re-invokes the url provider on every attempt, so a reconnect resumes from
// the current cursor — same as Last-Event-ID on SSE.
//
// The frame's runId is stamped onto the event before the widget sees it. The
// widget partitions by `event.runId`, and a payload from a CLI older than
// protocol 0.12 names no run — so without this, every run of the PR folds into
// one row. The frame's runId wins over the producer's: it is the run id the
// `?run=` deep link, the run picker and the D1 row all mean. The report fold
// stamps the same id on its own read path (scenetest-bridge/routes.ts).
export function createCloudPrTransport(owner: string, name: string, prNumber: number): Transport {
  const base = `/api/cloud/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pr/${prNumber}`
  const proto = () => (location.protocol === 'https:' ? 'wss' : 'ws')
  return {
    subscribe(onEvent, onStatus?: (status: ConnectionStatus) => void) {
      let cursor = 0
      let closed = false

      const ws = new ReconnectingWebSocket(
        () => `${proto()}://${location.host}${base}/ws?sinceId=${cursor}`,
        undefined,
        { minReconnectionDelay: 500, maxReconnectionDelay: 10_000 },
      )

      onStatus?.('connecting')
      ws.onopen = () => onStatus?.('connected')

      ws.onmessage = (e) => {
        const decoded = decodeFrame(e.data as string, cursor)
        if (!decoded) return
        cursor = decoded.id
        onEvent(decoded.event)
      }

      ws.onclose = () => {
        if (closed) return  // intentional unsubscribe; partysocket won't reconnect
        onStatus?.('disconnected')  // transient drop — partysocket reconnects
      }

      return () => {
        closed = true
        ws.close()
      }
    },

    // Commands are still run-scoped at the worker; the multi-run widget will
    // route them to the active run, so sendCommand is pending that contract
    // rather than guessing a target here.
    async sendCommand() {
      throw new Error('sendCommand not supported on the PR transport yet')
    },
  }
}

// One viewer frame decoded into the event the widget folds. Null when the frame
// is not an event, is malformed, or is at or below the cursor.
export function decodeFrame(data: string, cursor: number): { id: number; event: RunEvent } | null {
  let raw: unknown
  try {
    raw = JSON.parse(data)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const frame = raw as Record<string, unknown>
  if (frame.kind !== 'event' || typeof frame.id !== 'number') return null
  if (frame.id <= cursor) return null

  let payload: unknown
  try {
    payload = JSON.parse(frame.payload as string)
  } catch {
    return null
  }
  if (!isEventShaped(payload)) return null

  // The lenient check passes anything event-shaped, including event types this
  // build predates — so the cast is the leniency, made once, here. Mutating is
  // safe: the parse above minted this object and nothing else holds it.
  const event = payload as Record<string, unknown>
  if (typeof frame.runId === 'string') event.runId = frame.runId
  return { id: frame.id, event: event as unknown as RunEvent }
}
