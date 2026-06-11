import type { Handler } from '../router.ts'
import { verifyBoxToken } from '../middleware/bearer.ts'
import { insertEvents, type RunEvent } from '../db.ts'

// POST /api/events/:runId
// Body: { events: Array<{ seq: number, payload: unknown }> }
// Payload is opaque JSON (scenetest-js wire format). We store and forward.
export const postEvents: Handler = async (req, env, _ctx, params) => {
  const runId = params.runId!
  const auth = await verifyBoxToken(req, env, runId)
  if (!auth.ok) return auth.response

  const body = await req.json<{ events?: RunEvent[] }>()
  if (!body.events?.length) return new Response('No events', { status: 400 })

  await insertEvents(env.DB, runId, body.events)
  return Response.json({ ok: true, count: body.events.length })
}

// POST /api/runs/:runId/scene-executions
// Body: { executions: Array<SceneExecution> }
// SceneExecution = { id, scene_id, scene_file, scene_name, status, started_at?, ended_at?, summary? }
export const postSceneExecutions: Handler = async (req, env, _ctx, params) => {
  const runId = params.runId!
  const auth = await verifyBoxToken(req, env, runId)
  if (!auth.ok) return auth.response
  const run = auth.run

  const body = await req.json<{
    executions: Array<{
      id: string
      scene_id: string
      scene_file: string
      scene_name: string
      status: string
      started_at?: number | null
      ended_at?: number | null
      summary?: unknown
    }>
  }>()

  const stmt = env.DB.prepare(
    `INSERT INTO scene_executions
       (id, run_id, repo, pr_number, scene_id, scene_file, scene_name, head_sha, status, started_at, ended_at, summary_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       started_at = COALESCE(excluded.started_at, scene_executions.started_at),
       ended_at = COALESCE(excluded.ended_at, scene_executions.ended_at),
       summary_json = COALESCE(excluded.summary_json, scene_executions.summary_json)`,
  )

  await env.DB.batch(
    body.executions.map((e) =>
      stmt.bind(
        e.id,
        runId,
        run.repo,
        run.pr_number,
        e.scene_id,
        e.scene_file,
        e.scene_name,
        run.head_sha,
        e.status,
        e.started_at ?? null,
        e.ended_at ?? null,
        e.summary != null ? JSON.stringify(e.summary) : null,
      ),
    ),
  )
  return Response.json({ ok: true, count: body.executions.length })
}

// POST /api/runs/:runId/complete
// Body: { status: 'passed' | 'failed' | 'cancelled' }
export const postRunComplete: Handler = async (req, env, _ctx, params) => {
  const runId = params.runId!
  const auth = await verifyBoxToken(req, env, runId)
  if (!auth.ok) return auth.response

  const body = await req.json<{ status: 'passed' | 'failed' | 'cancelled' }>()
  await env.DB.prepare(
    'UPDATE runs SET status = ?1, ended_at = ?2 WHERE id = ?3',
  )
    .bind(body.status, Date.now(), runId)
    .run()
  return Response.json({ ok: true })
}
