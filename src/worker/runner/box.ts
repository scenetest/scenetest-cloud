import type { Env } from '../env.ts'
import type { BoxSpec } from './types.ts'
import { hashToken } from '../middleware/bearer.ts'
import { getRunner } from './registry.ts'
import { prCoordinator } from '../do/pr-coordinator.ts'

export interface PrRef {
  repo: string // 'owner/name'
  prNumber: number
  headSha: string
  baseSha: string | null
  baseRef: string
}

export interface BoxRow {
  id: string
  head_sha: string
  status: string
}

// Ensure a usable box exists for this PR at pr.headSha, provisioning one if
// the live box is missing or built for a different commit.
//
// First cut: a box is reused only when its head_sha matches exactly. The
// staged content-hash diff from architecture.md ("The build pipeline") —
// reuse the image when only deps changed, reuse deps when only the database
// changed, and so on — replaces this equality check once the pipeline-config
// file format is defined. That file is the next load-bearing design decision
// and is deliberately not invented here; until then, any code change rebuilds
// the whole box, which is correct, just not yet fast.
export async function ensureBox(
  env: Env,
  ctx: ExecutionContext,
  pr: PrRef,
): Promise<BoxRow> {
  const live = await env.DB.prepare(
    `SELECT id, head_sha, status FROM boxes
       WHERE repo = ?1 AND pr_number = ?2 AND status != 'destroyed'`,
  )
    .bind(pr.repo, pr.prNumber)
    .first<BoxRow>()

  if (live && live.head_sha === pr.headSha) {
    await env.DB.prepare('UPDATE boxes SET last_used_at = ?1 WHERE id = ?2')
      .bind(Date.now(), live.id)
      .run()
    return live
  }

  // Code changed (new commit) or no box yet: provision fresh. Retire any
  // prior box so the unique live-box index stays satisfied and the reaper
  // destroys its droplet.
  if (live) await retireBox(env, live.id)
  return provisionBox(env, ctx, pr)
}

async function provisionBox(env: Env, ctx: ExecutionContext, pr: PrRef): Promise<BoxRow> {
  const boxId = crypto.randomUUID()
  const bearerToken = crypto.randomUUID()
  const now = Date.now()
  const provider = env.RUNNER_PROVIDER ?? 'stub'
  // A stub box is usable immediately; a real box reports ready once its build
  // pipeline finishes on the droplet.
  const status = provider === 'digitalocean' ? 'provisioning' : 'ready'

  await env.DB.prepare(
    `INSERT INTO boxes
       (id, repo, pr_number, head_sha, status, bearer_token_hash, created_at, last_used_at, ready_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)`,
  )
    .bind(
      boxId,
      pr.repo,
      pr.prNumber,
      pr.headSha,
      status,
      await hashToken(bearerToken),
      now,
      status === 'ready' ? now : null,
    )
    .run()

  const spec: BoxSpec = {
    boxId,
    repo: pr.repo,
    prNumber: pr.prNumber,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    baseRef: pr.baseRef,
    imageVersion: env.RUNNER_IMAGE ?? 'stub',
  }
  const { runnerId } = await getRunner(env).provision(env, ctx, spec, bearerToken)

  // null = provisioning is pending (e.g. the runner image is still
  // building); the box row stays instance-less and the cron tick completes
  // it with a freshly minted token once the blocker clears.
  if (runnerId !== null) {
    await env.DB.prepare('UPDATE boxes SET runner_instance_id = ?1 WHERE id = ?2')
      .bind(runnerId, boxId)
      .run()
  }

  return { id: boxId, head_sha: pr.headSha, status }
}

// Mark the box for teardown and cancel its unfinished runs — latest wins:
// when a new commit retires the box, the only state worth a verdict is the
// new one, so in-flight batches for the old one stop counting immediately.
// The PR coordinator closes the box's WebSocket and drops its queued work;
// the reaper destroys the backing droplet on its next pass (boxes with
// status 'destroyed' are swept regardless of age) and repeats the run
// cancellation as an idempotent safety net.
export async function retireBox(env: Env, boxId: string): Promise<void> {
  const box = await env.DB.prepare('SELECT repo, pr_number FROM boxes WHERE id = ?1')
    .bind(boxId)
    .first<{ repo: string; pr_number: number }>()

  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE boxes SET status = 'destroyed', destroyed_at = ?1 WHERE id = ?2`,
    ).bind(now, boxId),
    env.DB.prepare(
      `UPDATE runs SET status = 'cancelled', ended_at = ?1
         WHERE box_id = ?2 AND ended_at IS NULL`,
    ).bind(now, boxId),
  ])

  if (box) {
    await prCoordinator(env, box.repo, box.pr_number).fetch('https://do/retire', {
      method: 'POST',
      body: JSON.stringify({ boxId }),
    })
  }
}
