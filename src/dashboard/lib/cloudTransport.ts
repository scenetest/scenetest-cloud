import type { ConnectionStatus, Transport } from '@scenetest/dashboard'
import { encodeCommand, isEventShaped, type Command } from '@scenetest/protocol'

// Transport adapter for cloud: the worker API, session-authed (cookies ride
// along automatically on same-origin EventSource and fetch).
//
// - Live events arrive over SSE at /api/runs/:runId/events, which replays the
//   run's buffered events from seq 0 on connect — so history comes through
//   `subscribe` and `fetchState` returns empty, same model as the dev
//   transport. The browser's automatic SSE reconnect sends Last-Event-ID,
//   which the worker honors, so a dropped connection resumes without replay.
// - Commands all POST to one endpoint as encoded protocol commands; the
//   worker validates and (once the PR coordinator lands) forwards them down
//   the box's command channel.
export function createCloudTransport(runId: string): Transport {
  const base = `/api/runs/${encodeURIComponent(runId)}`
  return {
    // SSE replays the run buffer on connect, so there is no separate snapshot.
    async fetchState() {
      return []
    },

    subscribe(onEvent, onStatus) {
      const source = new EventSource(`${base}/events`)
      const status = (s: ConnectionStatus) => onStatus?.(s)
      status('connecting')
      source.onopen = () => status('connected')
      // EventSource reconnects on its own unless it has given up entirely.
      source.onerror = () =>
        status(source.readyState === EventSource.CLOSED ? 'disconnected' : 'connecting')
      source.onmessage = (e) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(e.data as string)
        } catch {
          return
        }
        // Envelope check only — relay event types newer than this widget
        // rather than dropping them; the store ignores what it can't fold.
        if (isEventShaped(parsed)) onEvent(parsed as Parameters<typeof onEvent>[0])
      }
      return () => source.close()
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
