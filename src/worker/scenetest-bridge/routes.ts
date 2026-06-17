import { decodeCommand } from '@scenetest/protocol'
import type { Env } from '../env.ts'
import type { AuthedHandler } from '../auth/session.ts'
import { renderDashboard } from './html.ts'
import { prCoordinator } from '../do/pr-coordinator.ts'

export const dashboardHtml: AuthedHandler = () =>
  new Response(renderDashboard(), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

// GET /api/runs/:runId/log — download the raw event log as .jsonl. Serves the
// R2 artifact once it exists; before then (run in flight, or archive pending)
// it streams the live log from the run's PR object. Archived runs always have
// an artifact, so the log survives the object being reset.
export const getRunLog: AuthedHandler = async (_req, env, _ctx, params) => {
  const runId = params.runId!
  const run = await env.DB.prepare('SELECT repo, pr_number, artifact_key FROM runs WHERE id = ?1')
    .bind(runId)
    .first<{ repo: string; pr_number: number; artifact_key: string | null }>()
  if (!run) return new Response('run not found', { status: 404 })

  const headers = {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'content-disposition': `attachment; filename="${runId}.jsonl"`,
  }

  if (run.artifact_key && env.ARTIFACTS) {
    const obj = await env.ARTIFACTS.get(run.artifact_key)
    // Key recorded but object missing: fall through to the live log.
    if (obj) return new Response(obj.body, { headers })
  }
  const res = await prCoordinator(env, run.repo, run.pr_number).fetch(
    `https://do/jsonl?runId=${encodeURIComponent(runId)}`,
  )
  return new Response(res.body, { headers })
}

// GET /api/runs/:runId/ws — viewer WebSocket. Cookie auth (same-origin WS
// handshakes carry cookies), then forward the upgrade to the PR's DO where
// the socket is accepted, the backlog is replayed, and live events fan out.
export const dashboardWs: AuthedHandler = async (req, env, _ctx, params) => {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 })
  }
  const runId = params.runId!
  const run = await env.DB.prepare('SELECT repo, pr_number FROM runs WHERE id = ?1')
    .bind(runId)
    .first<{ repo: string; pr_number: number }>()
  if (!run) return new Response('run not found', { status: 404 })

  const doUrl = new URL('https://do/viewer-connect')
  doUrl.searchParams.set('runId', runId)
  const sinceSeq = new URL(req.url).searchParams.get('sinceSeq')
  if (sinceSeq) doUrl.searchParams.set('sinceSeq', sinceSeq)
  return prCoordinator(env, run.repo, run.pr_number).fetch(new Request(doUrl, req))
}

// POST /api/runs/:runId/commands — body is one encoded protocol command.
// Validation is strict (decodeCommand): commands get acted on, so unknown
// types are rejected rather than relayed. Valid commands go to the run's PR
// coordinator, which sends them down the box's WebSocket — or queues them
// until a box connects. 202 either way; `delivered` says which happened.
export const postRunCommand: AuthedHandler = async (req, env, _ctx, params) => {
  const command = decodeCommand(await req.text())
  if (!command) return Response.json({ error: 'not a valid command' }, { status: 400 })

  const runId = params.runId!
  const run = await env.DB.prepare('SELECT repo, pr_number FROM runs WHERE id = ?1')
    .bind(runId)
    .first<{ repo: string; pr_number: number }>()
  if (!run) return Response.json({ error: 'run not found' }, { status: 404 })

  const res = await prCoordinator(env, run.repo, run.pr_number).fetch('https://do/command', {
    method: 'POST',
    body: JSON.stringify({ runId, command }),
  })
  const { delivered } = (await res.json()) as { delivered: boolean }
  return Response.json({ delivered }, { status: 202 })
}
