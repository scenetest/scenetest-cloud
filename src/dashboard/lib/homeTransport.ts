import { WebSocket as ReconnectingWebSocket } from 'partysocket'
import type { HomeTile } from '../types.ts'

// Messages the HomeCoordinator sends down the home WebSocket.
export type HomeMsg =
  | { kind: 'snapshot'; tiles: HomeTile[] }
  | { kind: 'tile'; tile: HomeTile }
  | { kind: 'remove'; repo: string; prNumber: number }

// Subscribe to the cross-PR home view live layer: one session-authed WebSocket
// (cookies ride along same-origin) to the HomeCoordinator. It replays the
// current tile snapshot on connect, then streams live run-status deltas.
// partysocket owns reconnect + backoff — same transport the PR viewer uses, one
// level up. Returns an unsubscribe function.
export function subscribeHome(onMsg: (msg: HomeMsg) => void): () => void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new ReconnectingWebSocket(
    () => `${proto}://${location.host}/api/cloud/home/ws`,
    undefined,
    { minReconnectionDelay: 500, maxReconnectionDelay: 10_000 },
  )

  ws.onmessage = (e) => {
    let msg: HomeMsg
    try { msg = JSON.parse(e.data as string) as HomeMsg } catch { return }
    if (msg && typeof msg === 'object' && typeof (msg as { kind?: unknown }).kind === 'string') onMsg(msg)
  }

  let closed = false
  return () => {
    if (closed) return
    closed = true
    ws.close()
  }
}
