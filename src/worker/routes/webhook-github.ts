import type { Handler } from '../router.ts'
import type { Env } from '../env.ts'
import { verifyWebhookSignature } from '../github.ts'
import { createRun } from '../runner/create-run.ts'

// POST /webhook/github
//
// Trigger pipeline: pull_request opened/synchronize/reopened on a watched
// repo → upsert prs → create a run for the new head sha (consuming the PR's
// next_push_filter as the scene subset, if set). 'closed' just updates PR
// state. Everything else is recorded and ignored.
//
// Responses are 200 for anything we chose to ignore — non-2xx makes GitHub
// surface the hook as failing and retry, which is only right when *we* are
// at fault (bad signature, missing config, thrown error).

interface PullRequestPayload {
  action: string
  number: number
  repository: { full_name: string }
  pull_request: {
    state: string
    head: { sha: string }
    base: { ref: string; sha: string }
  }
}

export const postGithubWebhook: Handler = async (req, env, ctx) => {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    return new Response('Webhook secret not configured', { status: 503 })
  }

  const rawBody = await req.text()
  const sigOk = await verifyWebhookSignature(
    env.GITHUB_WEBHOOK_SECRET,
    rawBody,
    req.headers.get('x-hub-signature-256'),
  )
  if (!sigOk) return new Response('Bad signature', { status: 401 })

  const deliveryId = req.headers.get('x-github-delivery') ?? crypto.randomUUID()
  const event = req.headers.get('x-github-event') ?? 'unknown'

  // Idempotency: GitHub redelivers (manually and on perceived failure).
  // First write wins; a duplicate delivery is acknowledged and dropped.
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO webhook_deliveries (delivery_id, event, received_at)
     VALUES (?1, ?2, ?3)`,
  )
    .bind(deliveryId, event, Date.now())
    .run()
  if (inserted.meta.changes === 0) {
    return Response.json({ ok: true, result: 'duplicate' })
  }

  const result = await handleEvent(env, ctx, event, rawBody)

  await env.DB.prepare(
    `UPDATE webhook_deliveries SET action = ?1, repo = ?2, pr_number = ?3, result = ?4
     WHERE delivery_id = ?5`,
  )
    .bind(result.action ?? null, result.repo ?? null, result.prNumber ?? null, result.result, deliveryId)
    .run()

  return Response.json({ ok: true, result: result.result })
}

interface HandleResult {
  result: string
  action?: string
  repo?: string
  prNumber?: number
}

async function handleEvent(
  env: Env,
  ctx: ExecutionContext,
  event: string,
  rawBody: string,
): Promise<HandleResult> {
  if (event === 'ping') return { result: 'ignored:ping' }
  if (event !== 'pull_request') return { result: `ignored:event:${event}` }

  const payload = JSON.parse(rawBody) as PullRequestPayload
  const { action, number: prNumber } = payload
  const repo = payload.repository.full_name
  const base = { result: '', action, repo, prNumber }

  const [owner, name] = repo.split('/')
  const watched = await env.DB.prepare(
    'SELECT 1 FROM watched_repo WHERE owner = ?1 AND name = ?2',
  )
    .bind(owner ?? '', name ?? '')
    .first()
  if (!watched) return { ...base, result: 'ignored:unwatched-repo' }

  const now = Date.now()

  if (action === 'closed') {
    await env.DB.prepare(
      `UPDATE prs SET state = 'closed', updated_at = ?1 WHERE repo = ?2 AND pr_number = ?3`,
    )
      .bind(now, repo, prNumber)
      .run()
    return { ...base, result: 'pr-closed' }
  }

  if (action !== 'opened' && action !== 'synchronize' && action !== 'reopened') {
    return { ...base, result: `ignored:action:${action}` }
  }

  const headSha = payload.pull_request.head.sha
  const baseRef = payload.pull_request.base.ref
  const baseSha = payload.pull_request.base.sha

  await env.DB.prepare(
    `INSERT INTO prs (repo, pr_number, head_sha, base_ref, state, opened_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?5)
     ON CONFLICT(repo, pr_number) DO UPDATE SET
       head_sha = excluded.head_sha, base_ref = excluded.base_ref,
       state = 'open', updated_at = ?5`,
  )
    .bind(repo, prNumber, headSha, baseRef, now)
    .run()

  // A queued filter ("on the next push, only re-run these scenes") is
  // consumed by exactly one run, then cleared.
  const prRow = await env.DB.prepare(
    'SELECT next_push_filter FROM prs WHERE repo = ?1 AND pr_number = ?2',
  )
    .bind(repo, prNumber)
    .first<{ next_push_filter: string | null }>()
  const filter = prRow?.next_push_filter
  const subset = filter ? (JSON.parse(filter) as string[]) : null
  if (filter) {
    await env.DB.prepare(
      'UPDATE prs SET next_push_filter = NULL WHERE repo = ?1 AND pr_number = ?2',
    )
      .bind(repo, prNumber)
      .run()
  }

  const { runId } = await createRun(env, ctx, {
    repo,
    prNumber,
    headSha,
    baseSha,
    baseRef,
    trigger: subset ? 'auto-filter' : 'push',
    subset,
  })
  return { ...base, result: `run-created:${runId}` }
}
