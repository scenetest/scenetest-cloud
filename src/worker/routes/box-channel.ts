import type { Handler } from '../router.ts'
import { hashToken } from '../middleware/bearer.ts'
import { prCoordinator } from '../do/pr-coordinator.ts'

// GET /api/boxes/:boxId/channel — the box's single outbound WebSocket.
//
// Auth is the box's bearer token, accepted from the Authorization header or
// (for clients that can't set headers on a WebSocket) a ?token= query param.
// The worker verifies it against the live box row, then hands the upgrade to
// the PR's coordinator — which is only reachable through the binding, so
// everything past this point trusts the connection.
export const boxChannel: Handler = async (req, env) => {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 })
  }
  const url = new URL(req.url)
  const boxId = url.pathname.split('/')[3]!

  const headerToken = /^Bearer\s+(.+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
  const token = headerToken ?? url.searchParams.get('token')
  if (!token) return new Response('Unauthorized', { status: 401 })

  const box = await env.DB.prepare(
    `SELECT repo, pr_number, bearer_token_hash FROM boxes
       WHERE id = ?1 AND status != 'destroyed'`,
  )
    .bind(boxId)
    .first<{ repo: string; pr_number: number; bearer_token_hash: string }>()
  if (!box) return new Response('Box not found', { status: 404 })
  if ((await hashToken(token)) !== box.bearer_token_hash) {
    return new Response('Unauthorized', { status: 401 })
  }

  const doUrl = new URL('https://do/box-connect')
  doUrl.searchParams.set('boxId', boxId)
  return prCoordinator(env, box.repo, box.pr_number).fetch(new Request(doUrl, req))
}
