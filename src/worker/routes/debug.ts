import type { Handler } from '../router.ts'
import { hashToken } from '../middleware/bearer.ts'
import { localStubRunner } from '../runner/stub.ts'

// POST /api/debug/stub-run
// Body: { prNumber?: number, subset?: string[] }
// Creates a fake PR + run + spawns the local stub runner. DEV-ONLY.
// Gated on ENABLE_DEBUG_ROUTES — must be explicitly enabled. The stub bypasses
// bearer auth (writes events straight to D1), so this is a wide-open execution
// path that must stay off in any environment with real users or real runners.
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

  const runId = crypto.randomUUID()
  const bearerToken = crypto.randomUUID()
  const bearerHash = await hashToken(bearerToken)

  await env.DB.prepare(
    `INSERT INTO runs (id, repo, pr_number, head_sha, trigger, subset_json, status, bearer_token_hash)
     VALUES (?1, ?2, ?3, ?4, 'manual', ?5, 'queued', ?6)`,
  )
    .bind(runId, repo, prNumber, headSha, body.subset ? JSON.stringify(body.subset) : null, bearerHash)
    .run()

  await localStubRunner.spawn(
    env,
    ctx,
    {
      runId,
      repo,
      prNumber,
      headSha,
      baseSha: null,
      baseRef: 'main',
      imageVersion: 'stub',
      subset: body.subset ?? null,
    },
    bearerToken,
  )

  return Response.json({
    runId,
    dashboardUrl: `/r/${runId}/dashboard/`,
    bearerToken, // returned once for dev convenience
  })
}
