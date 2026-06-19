import { decodeCommand } from '@scenetest/protocol'
import type { AuthedHandler } from '../auth/session.ts'
import { SESSION_COOKIE, jsonUnauthorized, verifySessionToken } from '../auth/session.ts'
import { parseCookies } from '../auth/cookies.ts'
import type { Handler } from '../router.ts'
import { prCoordinator } from '../do/pr-coordinator.ts'
import { readArtifactBoxJsonl } from '../artifacts.ts'

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
    // The R2 archive is the full log row; project it down to the box-compatible
    // {seq,payload} view so the download matches the live /jsonl. Key recorded
    // but object missing/empty → null → fall through to the live log.
    const jsonl = await readArtifactBoxJsonl(env, run.artifact_key)
    if (jsonl != null) return new Response(jsonl, { headers })
  }
  const res = await prCoordinator(env, run.repo, run.pr_number).fetch(
    `https://do/jsonl?runId=${encodeURIComponent(runId)}`,
  )
  return new Response(res.body, { headers })
}

// GET /api/cloud/repos/:owner/:name/pr/:number/ws — PR viewer WebSocket. Owns
// its auth (registered as a plain Handler, not via withSession) because it
// accepts the session token via ?session= as well as the cookie — a WS-only
// concession that does not belong in the shared cookie-auth path. After auth it
// forwards the upgrade to the PR's DO, which replays the whole PR's log (ordered
// by the PR-global id) and fans out live events. repo + pr name the
// coordinator; the DO needs no run filter (it is the PR).
export const prDashboardWs: Handler = async (req, env, _ctx, params) => {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 })
  }
  // Browsers send cookies automatically on same-origin WS; test clients that
  // cannot set headers pass ?session= explicitly.
  const cookies = parseCookies(req.headers.get('cookie'))
  const token = cookies[SESSION_COOKIE] ?? new URL(req.url).searchParams.get('session') ?? undefined
  const user = token ? await verifySessionToken(token, env) : null
  if (!user) return jsonUnauthorized()

  const repo = `${params.owner}/${params.name}`
  const prNumber = Number(params.number)
  if (!Number.isFinite(prNumber)) return new Response('bad pr number', { status: 400 })

  const doUrl = new URL('https://do/pr-viewer-connect')
  const sinceId = new URL(req.url).searchParams.get('sinceId')
  if (sinceId) doUrl.searchParams.set('sinceId', sinceId)
  // Name the PR so the DO can fold this PR's archived runs back into the stream.
  doUrl.searchParams.set('repo', repo)
  doUrl.searchParams.set('pr', String(prNumber))
  return prCoordinator(env, repo, prNumber).fetch(new Request(doUrl, req))
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
