import type { Handler } from '../router.ts'
import type { Env } from '../env.ts'
import { verifyBoxToken } from '../middleware/bearer.ts'
import type { RunEvent } from '../db.ts'
import { prCoordinator } from '../do/pr-coordinator.ts'
import { postCommitStatus } from '../github.ts'

// POST /api/events/:runId
// Body: { events: Array<{ seq: number, payload: unknown }> }
// Payload is opaque JSON (scenetest-js wire format). Routed through the DO so
// events are persisted and fanned out to connected viewers in one step.
export const postEvents: Handler = async (req, env, _ctx, params) => {
  const runId = params.runId!
  const auth = await verifyBoxToken(req, env, runId)
  if (!auth.ok) return auth.response

  const body = await req.json<{ events?: RunEvent[] }>()
  if (!body.events?.length) return new Response('No events', { status: 400 })

  const { repo, pr_number } = auth.run
  await prCoordinator(env, repo, pr_number).fetch(
    new Request(`https://do/ingest/${encodeURIComponent(runId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: body.events }),
    }),
  )
  return Response.json({ ok: true, count: body.events.length })
}

// POST /api/runs/:runId/complete
// Body: { status: 'passed' | 'failed' | 'cancelled' }
// `ended_at IS NULL` keeps this from resurrecting a run the worker already
// ended — e.g. cancelled because a new commit retired its box while the old
// box's completion report was still in flight.
export const postRunComplete: Handler = async (req, env, ctx, params) => {
  const runId = params.runId!
  const auth = await verifyBoxToken(req, env, runId)
  if (!auth.ok) return auth.response

  const body = await req.json<{ status: 'passed' | 'failed' | 'cancelled' }>()
  const res = await env.DB.prepare(
    'UPDATE runs SET status = ?1, ended_at = ?2 WHERE id = ?3 AND ended_at IS NULL',
  )
    .bind(body.status, Date.now(), runId)
    .run()
  // The run just reached a terminal state: ask its PR object to flush the log
  // to the durable R2 artifact. Best-effort via waitUntil — the cron archive
  // backstop is the guarantee if this drops.
  if (res.meta.changes > 0) {
    const { repo, pr_number, head_sha } = auth.run
    ctx.waitUntil(
      prCoordinator(env, repo, pr_number)
        .fetch('https://do/archive', { method: 'POST', body: JSON.stringify({ runId }) })
        .catch((err) =>
          console.error(`artifact(${runId}) failed: ${err instanceof Error ? err.message : err}`),
        ),
    )
    // Close the loop back to GitHub: a commit status on the head sha so the
    // PR's merge button reflects the verdict. Best-effort via waitUntil — a
    // GitHub hiccup must not fail the box's completion report.
    ctx.waitUntil(reportVerdict(env, runId, repo, pr_number, head_sha, body.status))
  }
  return Response.json({ ok: true, applied: res.meta.changes > 0 })
}

// Build the commit-status description from this run's scene tallies and link
// it at the PR dashboard, then hand off to the best-effort GitHub egress.
async function reportVerdict(
  env: Env,
  runId: string,
  repo: string,
  prNumber: number,
  headSha: string,
  status: 'passed' | 'failed' | 'cancelled',
): Promise<void> {
  let description: string
  if (status === 'cancelled') {
    description = 'Run cancelled — a newer commit retired this box'
  } else {
    const counts = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failing
         FROM scene_executions WHERE run_id = ?1`,
    )
      .bind(runId)
      .first<{ total: number; failing: number | null }>()
    const total = counts?.total ?? 0
    const failing = counts?.failing ?? 0
    description = total
      ? `${total} scene${total === 1 ? '' : 's'}, ${failing} failing`
      : status === 'passed'
        ? 'Run passed'
        : 'Run failed'
  }
  // Mirror src/dashboard/lib/paths.ts pr(); the worker doesn't import dashboard
  // code (kept in sync by hand). Omit target_url when the origin is unset.
  const targetUrl = env.PUBLIC_BASE_URL
    ? `${env.PUBLIC_BASE_URL}/repo/${repo}/pr/${prNumber}?run=${encodeURIComponent(runId)}`
    : undefined
  await postCommitStatus(env, { repo, sha: headSha, status, description, targetUrl })
}
