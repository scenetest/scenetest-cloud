import { isEventShaped, type RunEvent } from '@scenetest/protocol'

// Shared per-run "shape source": one viewer WebSocket per run, fanned out to
// every collection that attaches to it. This is the multiplex seam — today the
// server emits one untagged event stream ({ kind:'event', seq, payload }), so
// every subscriber sees every event and each collection's reducer decides what
// it cares about. When the server later tags frames with a `collection` (the
// Electric-style envelope), demuxing moves here and `subscribe` grows a
// collection filter — without any collection changing.
//
// Resume is by seq, exactly like cloudTransport: reconnect replays seq>lastSeq,
// and the client dedupes the register-first/replay overlap. The worst failure
// is a dropped socket → reconnect → replay the gap; no event is lost because
// the DO log is authoritative.

export interface ShapeSource {
  // Attach a listener. onReady fires once the initial connection is live (the
  // POC's "caught up" signal; the server has no up-to-date control message
  // yet). Returns an unsubscribe that closes the socket when the last
  // listener leaves.
  subscribe(onEvent: (event: RunEvent) => void, onReady?: () => void): () => void
}

export function createWsShapeSource(runId: string): ShapeSource {
  const base = `/api/runs/${encodeURIComponent(runId)}`
  const listeners = new Set<(event: RunEvent) => void>()
  const readyListeners = new Set<() => void>()
  let lastSeq = 0
  let closed = false
  let ws: WebSocket | null = null
  let backoff = 500

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}${base}/ws?sinceSeq=${lastSeq}`)

    ws.onopen = () => {
      backoff = 500
      for (const r of readyListeners) r()
    }

    ws.onmessage = (e) => {
      let raw: unknown
      try { raw = JSON.parse(e.data as string) } catch { return }
      if (!raw || typeof raw !== 'object') return
      const frame = raw as Record<string, unknown>
      if (frame.kind !== 'event' || typeof frame.seq !== 'number') return
      const seq = frame.seq
      if (seq <= lastSeq) return // dedupe replay/live overlap
      lastSeq = seq
      let payload: unknown
      try { payload = JSON.parse(frame.payload as string) } catch { return }
      if (!isEventShaped(payload)) return
      for (const l of listeners) l(payload as RunEvent)
    }

    ws.onclose = () => {
      if (closed) return
      setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 10_000)
    }
    ws.onerror = () => ws?.close()
  }

  return {
    subscribe(onEvent, onReady) {
      const firstListener = listeners.size === 0
      listeners.add(onEvent)
      if (onReady) readyListeners.add(onReady)
      if (firstListener) connect()
      return () => {
        listeners.delete(onEvent)
        if (onReady) readyListeners.delete(onReady)
        if (listeners.size === 0) {
          closed = true
          ws?.close()
        }
      }
    },
  }
}

// One source per run, memoized — so N collections share one socket.
const sources = new Map<string, ShapeSource>()
export function runShapeSource(runId: string): ShapeSource {
  let s = sources.get(runId)
  if (!s) {
    s = createWsShapeSource(runId)
    sources.set(runId, s)
  }
  return s
}
