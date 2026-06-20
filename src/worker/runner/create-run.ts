import type { Env } from '../env.ts'
import type { RunSpec } from './types.ts'
import { getRunner } from './registry.ts'
import { ensureBox, type PrRef } from './box.ts'
import { computeStagePlan } from './pipeline.ts'

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

  // The desired stage vectors for head and base (#25). The head vector is the
  // same computeStagePlan output ensureBox queued to the box, so the hashes the
  // box tags its reports with line up here; the base vector resolves the
  // "report at base hash" side of the PR comparison without re-hitting GitHub on
  // every page load. Both degrade to the coarse pseudo-vector on any failure;
  // base is skipped entirely when the PR has no base sha (a manual stub run).
  const headVector = (await computeStagePlan(env, opts.repo, opts.headSha)).vector
  const baseVector = opts.baseSha
    ? (await computeStagePlan(env, opts.repo, opts.baseSha)).vector
    : null

  const runId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO runs
       (id, repo, pr_number, head_sha, base_sha, trigger, subset_json, status, box_id, triggered_by_user_id,
        head_vector_json, base_vector_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', ?8, ?9, ?10, ?11)`,
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
      JSON.stringify(headVector),
      baseVector ? JSON.stringify(baseVector) : null,
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
