import type { ConnectionStatus, Transport } from '@scenetest/dashboard'
import { encodeCommand, isEventShaped, type Command } from '@scenetest/protocol'

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
// - On disconnect, exponential backoff reconnect resumes with ?sinceSeq so
//   replay only covers the gap — same semantics as Last-Event-ID on SSE.
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
      let ws: WebSocket | null = null
      let backoff = 500

      const connect = () => {
        onStatus?.('connecting')
        const proto = location.protocol === 'https:' ? 'wss' : 'ws'
        ws = new WebSocket(`${proto}://${location.host}${base}/ws?sinceSeq=${lastSeq}`)

        ws.onopen = () => {
          backoff = 500
          onStatus?.('connected')
        }

        ws.onmessage = (e) => {
          let frame: unknown
          try { frame = JSON.parse(e.data as string) } catch { return }
          if (
            frame == null ||
            typeof frame !== 'object' ||
            (frame as Record<string, unknown>).kind !== 'event' ||
            typeof (frame as Record<string, unknown>).seq !== 'number'
          ) return
          const seq = (frame as Record<string, unknown>).seq as number
          if (seq <= lastSeq) return  // dedupe replay/live overlap
          lastSeq = seq
          let payload: unknown
          try { payload = JSON.parse((frame as Record<string, unknown>).payload as string) } catch { return }
          if (isEventShaped(payload)) onEvent(payload as Parameters<typeof onEvent>[0])
        }

        ws.onclose = () => {
          if (closed) return
          onStatus?.('disconnected')
          setTimeout(connect, backoff)
          backoff = Math.min(backoff * 2, 10_000)
        }

        ws.onerror = () => ws?.close()
      }

      connect()
      return () => {
        closed = true
        ws?.close()
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
