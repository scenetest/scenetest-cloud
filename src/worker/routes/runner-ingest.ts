import type { Env } from '../env.ts'
import type { Handler } from '../router.ts'
import { verifyRunBearer } from '../middleware/bearer.ts'

// POST /api/events/:runId
// Body: { seq: number, payload: unknown } | { events: Array<{seq, payload}> }
// Payload is opaque JSON (scenetest-js wire format). We store and forward.
export const postEvents: Handler = async (req, env, _ctx, params) => {
  const runId = params.runId
  if (!runId) return new Response('runId required', { status: 400 })
  const auth = await verifyRunBearer(req, env, runId)
  if (!auth.ok) return auth.response

  const body = await req.json<{
    seq?: number
    payload?: unknown
    events?: Array<{ seq: number; payload: unknown }>
  }>()
  const batch = body.events ?? (body.seq != null ? [{ seq: body.seq, payload: body.payload }] : [])
  if (batch.length === 0) return new Response('No events', { status: 400 })

  const now = Date.now()
  const stmt = env.DB.prepare(
    'INSERT INTO events (run_id, seq, payload, ts) VALUES (?1, ?2, ?3, ?4)',
  )
  await env.DB.batch(
    batch.map((e) => stmt.bind(runId, e.seq, JSON.stringify(e.payload ?? null), now)),
  )
  return Response.json({ ok: true, count: batch.length })
}

// POST /api/runs/:runId/scene-executions
// Body: { executions: Array<SceneExecution> }
// SceneExecution = { id, scene_id, scene_file, scene_name, status, started_at?, ended_at?, summary? }
export const postSceneExecutions: Handler = async (req, env, _ctx, params) => {
  const runId = params.runId
  if (!runId) return new Response('runId required', { status: 400 })
  const auth = await verifyRunBearer(req, env, runId)
  if (!auth.ok) return auth.response

  const run = await env.DB.prepare(
    'SELECT pr_number, head_sha FROM runs WHERE id = ?1',
  )
    .bind(runId)
    .first<{ pr_number: number; head_sha: string }>()
  if (!run) return new Response('Run not found', { status: 404 })

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
       (id, run_id, pr_number, scene_id, scene_file, scene_name, head_sha, status, started_at, ended_at, summary_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
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
  const runId = params.runId
  if (!runId) return new Response('runId required', { status: 400 })
  const auth = await verifyRunBearer(req, env, runId)
  if (!auth.ok) return auth.response

  const body = await req.json<{ status: 'passed' | 'failed' | 'cancelled' }>()
  const now = Date.now()
  await env.DB.prepare(
    'UPDATE runs SET status = ?1, ended_at = ?2 WHERE id = ?3',
  )
    .bind(body.status, now, runId)
    .run()
  return Response.json({ ok: true })
}
