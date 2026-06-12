import type { Handler } from '../router.ts'
import { createRun } from '../runner/create-run.ts'
import { prCoordinator } from '../do/pr-coordinator.ts'

// POST /api/debug/box-update
// Body: { boxId, headSha?, vector?, stages? } — enqueue a pipeline update on
// the box's coordinator, exactly as ensureBox would. Exists so the e2e
// script can exercise the agent's update path (checkout → stages → ready
// with realized vector) without a real GitHub tree. DEV-ONLY, same gate as
// stub-run.
export const debugBoxUpdate: Handler = async (req, env) => {
  if (env.ENABLE_DEBUG_ROUTES !== '1') {
    return new Response('Not Found', { status: 404 })
  }
  const body = await req.json<{
    boxId: string
    headSha?: string
    vector?: Record<string, string>
    stages?: Array<{ name: string; run?: string }>
    scenes?: string
  }>()
  const box = await env.DB.prepare('SELECT repo, pr_number FROM boxes WHERE id = ?1')
    .bind(body.boxId)
    .first<{ repo: string; pr_number: number }>()
  if (!box) return Response.json({ error: 'box not found' }, { status: 404 })

  const res = await prCoordinator(env, box.repo, box.pr_number).fetch('https://do/update', {
    method: 'POST',
    body: JSON.stringify({
      headSha: body.headSha,
      vector: body.vector,
      stages: body.stages ?? [],
      scenes: body.scenes,
    }),
  })
  return Response.json(await res.json(), { status: 202 })
}

// POST /api/debug/box-dispatch
// Body: { boxId, run: RunSpec-ish } — enqueue a scene batch on the box's
// coordinator, as createRun's dispatch would, so e2e can exercise the
// agent's batch path (scenes command, events-file relay, verdict). DEV-ONLY.
export const debugBoxDispatch: Handler = async (req, env) => {
  if (env.ENABLE_DEBUG_ROUTES !== '1') {
    return new Response('Not Found', { status: 404 })
  }
  const body = await req.json<{ boxId: string; run: unknown }>()
  const box = await env.DB.prepare('SELECT repo, pr_number FROM boxes WHERE id = ?1')
    .bind(body.boxId)
    .first<{ repo: string; pr_number: number }>()
  if (!box) return Response.json({ error: 'box not found' }, { status: 404 })

  const res = await prCoordinator(env, box.repo, box.pr_number).fetch('https://do/dispatch', {
    method: 'POST',
    body: JSON.stringify({ run: body.run }),
  })
  return Response.json(await res.json(), { status: 202 })
}

// POST /api/debug/stub-run
// Body: { prNumber?: number, subset?: string[] }
// Upserts a fake PR and creates a run through the normal path (ensure box →
// insert run → dispatch); with the stub provider this fabricates events
// straight to D1. DEV-ONLY, gated on ENABLE_DEBUG_ROUTES — a wide-open
// execution path that must stay off anywhere with real users or runners.
export const debugStubRun: Handler = async (req, env, ctx) => {
  if (env.ENABLE_DEBUG_ROUTES !== '1') {
    return new Response('Not Found', { status: 404 })
  }
  const body = await req
    .json<{ prNumber?: number; subset?: string[] }>()
    .catch(() => ({} as { prNumber?: number; subset?: string[] }))
  const repo = 'demo/repo'
  const prNumber = body.prNumber ?? 1
  const headSha = `sha-${Math.random().toString(36).slice(2, 10)}`
  const now = Date.now()

  await env.DB.prepare(
    `INSERT INTO prs (repo, pr_number, head_sha, base_ref, state, opened_at, updated_at)
     VALUES (?1, ?2, ?3, 'main', 'open', ?4, ?4)
     ON CONFLICT(repo, pr_number) DO UPDATE SET head_sha = excluded.head_sha, updated_at = ?4`,
  )
    .bind(repo, prNumber, headSha, now)
    .run()

  const { runId } = await createRun(env, ctx, {
    repo,
    prNumber,
    headSha,
    baseSha: null,
    baseRef: 'main',
    trigger: 'manual',
    subset: body.subset ?? null,
  })

  return Response.json({ runId, dashboardUrl: `/r/${runId}/dashboard/` })
}
