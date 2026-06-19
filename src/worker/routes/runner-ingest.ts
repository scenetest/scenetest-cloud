import type { Handler } from '../router.ts'
import { verifyBoxToken } from '../middleware/bearer.ts'
import type { RunEvent } from '../db.ts'
import { prCoordinator } from '../do/pr-coordinator.ts'

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
    const { repo, pr_number } = auth.run
    ctx.waitUntil(
      prCoordinator(env, repo, pr_number)
        .fetch('https://do/archive', { method: 'POST', body: JSON.stringify({ runId }) })
        .catch((err) =>
          console.error(`artifact(${runId}) failed: ${err instanceof Error ? err.message : err}`),
        ),
    )
  }
  return Response.json({ ok: true, applied: res.meta.changes > 0 })
}
