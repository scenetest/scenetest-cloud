import type { Handler } from '../router.ts'
import type { Env } from '../env.ts'
import { hashToken } from '../middleware/bearer.ts'
import { prCoordinator } from '../do/pr-coordinator.ts'

interface BoxRow {
  repo: string
  pr_number: number
  bearer_token_hash: string
}

async function verifyBox(env: Env, boxId: string, token: string | null) {
  if (!token) return null
  const box = await env.DB.prepare(
    `SELECT repo, pr_number, bearer_token_hash FROM boxes
       WHERE id = ?1 AND status != 'destroyed'`,
  )
    .bind(boxId)
    .first<BoxRow>()
  if (!box || (await hashToken(token)) !== box.bearer_token_hash) return null
  return box
}

// GET /api/boxes/:boxId/channel — the box's single outbound WebSocket.
//
// Auth is the box's bearer token, accepted from the Authorization header or
// (for clients that can't set headers on a WebSocket) a ?token= query param.
// The worker verifies it against the live box row, then hands the upgrade to
// the PR's coordinator — which is only reachable through the binding, so
// everything past this point trusts the connection.
export const boxChannel: Handler = async (req, env, _ctx, params) => {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 })
  }
  const url = new URL(req.url)
  const boxId = params.boxId!
  const headerToken = /^Bearer\s+(.+)$/.exec(req.headers.get('authorization') ?? '')?.[1]

  const box = await verifyBox(env, boxId, headerToken ?? url.searchParams.get('token'))
  if (!box) return new Response('Unauthorized', { status: 401 })

  const doUrl = new URL('https://do/box-connect')
  doUrl.searchParams.set('boxId', boxId)
  return prCoordinator(env, box.repo, box.pr_number).fetch(new Request(doUrl, req))
}

// POST /api/boxes/:boxId/ready — the agent reports its build pipeline done
// (checkout, setup, app up). Until this lands, a DigitalOcean box sits in
// 'provisioning'; the stub provider marks its boxes ready directly.
export const boxReady: Handler = async (req, env, _ctx, params) => {
  const boxId = params.boxId!
  const headerToken = /^Bearer\s+(.+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
  const box = await verifyBox(env, boxId, headerToken ?? null)
  if (!box) return new Response('Unauthorized', { status: 401 })

  await env.DB.prepare(
    `UPDATE boxes SET status = 'ready', ready_at = ?1
       WHERE id = ?2 AND status = 'provisioning'`,
  )
    .bind(Date.now(), boxId)
    .run()
  return Response.json({ ok: true })
}
