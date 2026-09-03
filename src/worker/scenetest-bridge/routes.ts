import { decodeCommand, isEventShaped } from '@scenetest/protocol'
import type { RunEvent } from '@scenetest/protocol'
import type { Env } from '../env.ts'
import type { AuthedHandler } from '../auth/session.ts'
import { getWsSessionUser, jsonUnauthorized } from '../auth/session.ts'
import type { Handler } from '../router.ts'
import { prCoordinator } from '../do/pr-coordinator.ts'
import { readArtifactBoxJsonl, readArtifactEvents } from '../artifacts.ts'
import { buildRunReport } from './run-report.ts'

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
  return new Response((await liveRunLog(env, run.repo, run.pr_number, runId)).body, { headers })
}

// GET /api/cloud/repos/:owner/:name/pr/:number/ws — PR viewer WebSocket. Owns
// its auth (registered as a plain Handler, not via withSession) because it
// accepts the session token via ?session= as well as the cookie — a WS-only
// concession (gated to dev/test, see getWsSessionUser) that does not belong in
// the shared cookie-auth path. After auth it forwards the upgrade to the PR's
// DO, which replays the whole PR's log (ordered by the PR-global id) and fans
// out live events. repo + pr name the coordinator; the DO needs no run filter
// (it is the PR).
export const prDashboardWs: Handler = async (req, env, _ctx, params) => {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 })
  }
  // Browsers send the cookie automatically on same-origin WS; the ?session=
  // fallback for header-less test clients is honored only under dev gating.
  const user = await getWsSessionUser(req, env)
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

// GET /api/cloud/home/ws — home view live layer. Same auth shape as the PR
// viewer WS (cookie always; ?session= only under dev gating), then forwards the
// upgrade to the singleton HomeCoordinator, which replays the current tile
// snapshot and fans out live run-status rollups. One socket for the whole
// cross-PR home view.
export const homeDashboardWs: Handler = async (req, env) => {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 })
  }
  const user = await getWsSessionUser(req, env)
  if (!user) return jsonUnauthorized()

  return env.HOME_COORDINATOR.get(env.HOME_COORDINATOR.idFromName('global')).fetch(req)
}

// POST /api/cloud/repos/:owner/:name/pr/:number/commands — body is
// { command, runId? }. The PR (owner/name + number) names the coordinator
// directly, so there is no runId→PR lookup: the run is not the address, the PR
// is. Commands act on the PR's active run (run:stop/pause/resume/replay); the
// optional `runId` rides along as transport metadata for the box's per-run
// bookkeeping, omitted when the command is run-agnostic. Validation is strict
// (decodeCommand): commands get acted on, so unknown types are rejected rather
// than relayed. Valid commands go to the PR coordinator, which sends them down
// the box's WebSocket — or queues them until a box connects. 202 either way;
// `delivered` says which happened.
export const postPrCommand: AuthedHandler = async (req, env, _ctx, params) => {
  const repo = `${params.owner}/${params.name}`
  const prNumber = Number(params.number)
  if (!Number.isFinite(prNumber)) return Response.json({ error: 'bad pr number' }, { status: 400 })

  const body = (await req.json().catch(() => null)) as { command?: unknown; runId?: string } | null
  const command = decodeCommand(body?.command)
  if (!command) return Response.json({ error: 'not a valid command' }, { status: 400 })

  const res = await prCoordinator(env, repo, prNumber).fetch('https://do/command', {
    method: 'POST',
    body: JSON.stringify({ runId: body?.runId, command }),
  })
  const { delivered } = (await res.json()) as { delivered: boolean }
  return Response.json({ delivered }, { status: 202 })
}

// GET /api/cloud/repos/:owner/:name/pr/:number/runs — the PR's runs, newest
// first, for the widget's run picker. `mtime` is what the picker labels each
// option with: when the run ended, or when it started while it still runs.
export const listPrRuns: AuthedHandler = async (_req, env, _ctx, params) => {
  const repo = `${params.owner}/${params.name}`
  const prNumber = Number(params.number)
  if (!Number.isFinite(prNumber)) return Response.json({ error: 'bad pr number' }, { status: 400 })

  const rows = await env.DB.prepare(
    `SELECT id, COALESCE(ended_at, started_at, 0) AS mtime FROM runs
       WHERE repo = ?1 AND pr_number = ?2
       ORDER BY mtime DESC, rowid DESC
       LIMIT 100`,
  )
    .bind(repo, prNumber)
    .all<{ id: string; mtime: number }>()

  return Response.json({ runs: rows.results ?? [] })
}

// GET /api/cloud/repos/:owner/:name/pr/:number/runs/:runId — one run's report:
// its event log folded into scenes, each with its assertions and timeline.
// The PR in the path is the authority: a run belonging to another PR is a 404
// here, not someone else's report.
export const getPrRunReport: AuthedHandler = async (_req, env, _ctx, params) => {
  const repo = `${params.owner}/${params.name}`
  const prNumber = Number(params.number)
  const runId = params.runId!
  if (!Number.isFinite(prNumber)) return Response.json({ error: 'bad pr number' }, { status: 400 })

  const run = await env.DB.prepare(
    'SELECT artifact_key FROM runs WHERE id = ?1 AND repo = ?2 AND pr_number = ?3',
  )
    .bind(runId, repo, prNumber)
    .first<{ artifact_key: string | null }>()
  if (!run) return Response.json({ error: 'run not found' }, { status: 404 })

  const events = await readRunEvents(env, repo, prNumber, runId, run.artifact_key)
  return Response.json(buildRunReport(events))
}

// A run's events, oldest first: the R2 artifact once it exists, else the live
// log from the PR object — the same source order the /log download uses.
//
// Parsed leniently (isEventShaped, not isRunEvent): a log written by an older
// CLI predates fields the strict check now requires, and a report of a real run
// must not come back empty because its producer was a version behind. The run
// id is stamped on for the same reason — the fold partitions by `event.runId`,
// and the cloud's id is the one the log filed the event under.
async function readRunEvents(
  env: Env,
  repo: string,
  prNumber: number,
  runId: string,
  artifactKey: string | null,
): Promise<RunEvent[]> {
  const archived = artifactKey ? await readArtifactEvents(env, artifactKey) : null
  const payloads = archived ?? parseJsonl(await (await liveRunLog(env, repo, prNumber, runId)).text())

  const events: RunEvent[] = []
  for (const payload of payloads) {
    if (isEventShaped(payload)) {
      events.push({ ...(payload as object), runId } as unknown as RunEvent)
    }
  }
  return events
}

// The PR object's live log for one run, as the box-compatible .jsonl.
function liveRunLog(env: Env, repo: string, prNumber: number, runId: string): Promise<Response> {
  return prCoordinator(env, repo, prNumber).fetch(
    `https://do/jsonl?runId=${encodeURIComponent(runId)}`,
  )
}

// `{"seq":N,"payload":…}` per line — the payloads only; the report has no use
// for the box's sequence.
function parseJsonl(jsonl: string): unknown[] {
  const out: unknown[] = []
  for (const line of jsonl.split('\n')) {
    if (!line) continue
    try {
      out.push((JSON.parse(line) as { payload?: unknown }).payload)
    } catch {
      continue
    }
  }
  return out
}
