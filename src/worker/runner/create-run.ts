import type { Env } from '../env.ts'
import type { RunSpec } from './types.ts'
import { getRunner } from './registry.ts'
import { ensureBox, type PrRef } from './box.ts'

export { getRunner }

export interface CreateRunOptions extends PrRef {
  trigger: 'push' | 'manual' | 'auto-filter'
  subset: string[] | null
  triggeredByUserId?: number
}

// A run is a batch of scene executions against the PR's box. This ensures the
// box exists (provisioning it if the commit changed), inserts the run row, and
// dispatches the batch to the box. The run owns no box, credential, or runner
// — those belong to the box (one per PR).
export async function createRun(
  env: Env,
  ctx: ExecutionContext,
  opts: CreateRunOptions,
): Promise<{ runId: string; boxId: string }> {
  const box = await ensureBox(env, ctx, opts)

  const runId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO runs
       (id, repo, pr_number, head_sha, base_sha, trigger, subset_json, status, box_id, triggered_by_user_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', ?8, ?9)`,
  )
    .bind(
      runId,
      opts.repo,
      opts.prNumber,
      opts.headSha,
      opts.baseSha,
      opts.trigger,
      opts.subset ? JSON.stringify(opts.subset) : null,
      box.id,
      opts.triggeredByUserId ?? null,
    )
    .run()

  const spec: RunSpec = {
    runId,
    boxId: box.id,
    repo: opts.repo,
    prNumber: opts.prNumber,
    headSha: opts.headSha,
    subset: opts.subset,
  }
  await getRunner(env).dispatch(env, ctx, spec)

  return { runId, boxId: box.id }
}

export interface ReplayOptions {
  repo: string // 'owner/name'
  prNumber: number
  // The scene file to replay (a batch of one); omitted = replay all scenes.
  file?: string
  // The team to run as. Upstream-blocked: the scenes CLI has no team selection
  // as of 0.15, so this does not take effect end to end yet — see below.
  team?: string
  triggeredByUserId?: number
}

// A replay is worker-side run creation, not a box-side file: the `run:replay`
// command starts a NEW run against the PR's warm box, exactly like a manual
// re-run, rather than poking the in-flight one. So it goes through the same
// createRun path as any other run — ensureBox reuses the warm box (actor/team
// changes sit below every build stage, so a replay is a batch of one execution,
// not a provisioning cycle). The PR's current head/base come from D1.
//
// `file` becomes the run's one-scene subset. `team` is upstream-blocked: the
// scenes CLI accepts positional scene paths (file subsets) but has no team
// selection as of 0.15, so it is accepted but does not yet take effect end to
// end. scene_executions.params_json (migration 0003) is where the team/variant
// will land once the CLI honors it. Returns null when the PR is unknown.
export async function replayRun(
  env: Env,
  ctx: ExecutionContext,
  opts: ReplayOptions,
): Promise<{ runId: string; boxId: string } | null> {
  const pr = await env.DB.prepare(
    'SELECT head_sha, base_ref FROM prs WHERE repo = ?1 AND pr_number = ?2',
  )
    .bind(opts.repo, opts.prNumber)
    .first<{ head_sha: string; base_ref: string }>()
  if (!pr) return null

  // base_sha is context the comparison projections carry, not a runtime input;
  // reuse the PR's most recent run's value (best-effort, null if there is none).
  const base = await env.DB.prepare(
    'SELECT base_sha FROM runs WHERE repo = ?1 AND pr_number = ?2 ORDER BY rowid DESC LIMIT 1',
  )
    .bind(opts.repo, opts.prNumber)
    .first<{ base_sha: string | null }>()

  return createRun(env, ctx, {
    repo: opts.repo,
    prNumber: opts.prNumber,
    headSha: pr.head_sha,
    baseSha: base?.base_sha ?? null,
    baseRef: pr.base_ref,
    trigger: 'manual',
    subset: opts.file ? [opts.file] : null,
    triggeredByUserId: opts.triggeredByUserId,
  })
}
