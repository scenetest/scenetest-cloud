import type { Handler } from '../router.ts'
import { createRun } from '../runner/create-run.ts'

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
