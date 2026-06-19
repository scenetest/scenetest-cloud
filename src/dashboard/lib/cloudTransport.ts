import type { ConnectionStatus, Transport } from '@scenetest/dashboard'
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
// (Surfacing runId/seq to the widget — so it can key its own collection and
// group by run — rides the scenetest-js Transport update; today's onEvent only
// carries the protocol event, so we forward payload and track id for resume.)
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
        let raw: unknown
        try { raw = JSON.parse(e.data as string) } catch { return }
        if (!raw || typeof raw !== 'object') return
        const frame = raw as Record<string, unknown>
        if (frame.kind !== 'event' || typeof frame.id !== 'number') return
        const id = frame.id as number
        if (id <= cursor) return  // dedupe replay/live overlap
        cursor = id
        let payload: unknown
        try { payload = JSON.parse(frame.payload as string) } catch { return }
        if (isEventShaped(payload)) onEvent(payload as Parameters<typeof onEvent>[0])
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

