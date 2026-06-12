import type { Handler } from '../router.ts'
import type { Env } from '../env.ts'
import { bearerFrom, hashToken } from '../middleware/bearer.ts'
import { prCoordinator } from '../do/pr-coordinator.ts'
import { retireBox } from '../runner/box.ts'

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

// POST /api/boxes/:boxId/ready — the agent reports a pipeline update's
// outcome. Success carries the realized stage vector (echoed from the
// update message) and the sha it now embodies; ensureBox diffs future
// pushes against it. `ok: false` means a stage failed: the box can't serve
// runs for this state, so it's retired (reaper destroys the droplet, queued
// runs cancel) and the next push provisions fresh.
// Body is optional for backward compatibility (bare ready, no vector).
export const boxReady: Handler = async (req, env, _ctx, params) => {
  const boxId = params.boxId!
  const box = await verifyBox(env, boxId, bearerFrom(req))
  if (!box) return new Response('Unauthorized', { status: 401 })

  const body = (await req.json().catch(() => ({}))) as {
    ok?: boolean
    realized?: Record<string, string>
    head_sha?: string
    failed_stage?: string
  }

  if (body.ok === false) {
    console.error(`box ${boxId}: pipeline stage '${body.failed_stage ?? '?'}' failed; retiring`)
    await retireBox(env, boxId)
    return Response.json({ ok: true, retired: true })
  }

  await env.DB.prepare(
    `UPDATE boxes SET status = 'ready', ready_at = ?1,
        realized_stages = COALESCE(?2, realized_stages),
        head_sha = COALESCE(?3, head_sha)
      WHERE id = ?4 AND status IN ('provisioning', 'rebuilding', 'ready')`,
  )
    .bind(
      Date.now(),
      body.realized ? JSON.stringify(body.realized) : null,
      body.head_sha ?? null,
      boxId,
    )
    .run()
  return Response.json({ ok: true, retired: false })
}
