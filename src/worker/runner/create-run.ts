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
