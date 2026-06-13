import type { ConnectionStatus, Transport } from '@scenetest/dashboard'
import { encodeCommand, isEventShaped, type Command } from '@scenetest/protocol'
import { WebSocket as ReconnectingWebSocket } from 'partysocket'

// Transport adapter for cloud: the worker API, session-authed (cookies ride
// along automatically on same-origin WebSocket and fetch).
//
// - Live events arrive over WebSocket at /api/runs/:runId/ws. On connect the
//   DO replays the run's buffered events (seq > sinceSeq) then streams live
//   frames as they arrive. Both replay and live frames have shape:
//     { kind: 'event', seq: number, payload: string }
//   where payload is a JSON string — call JSON.parse(frame.payload) to get
//   the protocol event.
// - The client tracks lastSeq and dedupes any frame with seq <= lastSeq
//   (overlap from register-first-then-replay can send a frame twice).
// - partysocket owns reconnect + backoff; it re-invokes the url provider on
//   every attempt, so a reconnect resumes with the current ?sinceSeq — replay
//   only covers the gap, same semantics as Last-Event-ID on SSE.
// - fetchState() returns [] because the replay on connect covers history.
// - Commands POST to one endpoint as encoded protocol commands.
export function createCloudTransport(runId: string): Transport {
  const base = `/api/runs/${encodeURIComponent(runId)}`
  return {
    async fetchState() {
      return []
    },

    subscribe(onEvent, onStatus) {
      let lastSeq = 0
      let closed = false

      // partysocket calls this provider for every (re)connect, so sinceSeq is
      // re-read each time and reconnects resume from the last applied seq.
      const url = () => {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws'
        return `${proto}://${location.host}${base}/ws?sinceSeq=${lastSeq}`
      }

      onStatus?.('connecting')
      // Reconnect + backoff (500ms→10s) are partysocket's job — no manual loop.
      const ws = new ReconnectingWebSocket(url, undefined, {
        minReconnectionDelay: 500,
        maxReconnectionDelay: 10_000,
      })

      ws.onopen = () => onStatus?.('connected')

      ws.onmessage = (e) => {
        let raw: unknown
        try { raw = JSON.parse(e.data as string) } catch { return }
        if (!raw || typeof raw !== 'object') return
        const frame = raw as Record<string, unknown>
        if (frame.kind !== 'event' || typeof frame.seq !== 'number') return
        const seq = frame.seq as number
        if (seq <= lastSeq) return  // dedupe replay/live overlap
        lastSeq = seq
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

    async sendCommand(command: Command) {
      const res = await fetch(`${base}/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: encodeCommand(command),
      })
      if (!res.ok) throw new Error(`command rejected: ${res.status}`)
    },
  }
}
