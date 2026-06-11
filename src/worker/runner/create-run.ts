import type { Env } from '../env.ts'
import type { JobSpec, Runner } from './types.ts'
import { hashToken } from '../middleware/bearer.ts'
import { localStubRunner } from './stub.ts'
import { digitalOceanRunner } from './digitalocean.ts'

export function getRunner(env: Env): Runner {
  if (env.RUNNER_PROVIDER === 'digitalocean') return digitalOceanRunner
  return localStubRunner
}

export interface CreateRunOptions {
  repo: string // 'owner/name'
  prNumber: number
  headSha: string
  baseSha: string | null
  baseRef: string
  trigger: 'push' | 'manual' | 'auto-filter'
  subset: string[] | null
  triggeredByUserId?: number
}

// The single path from "we decided to test this sha" to "a runner is going".
// Inserts the run row, mints the per-run bearer token (stored only as a
// hash; the plaintext goes to the runner and nowhere else), and spawns the
// configured runner.
export async function createRun(
  env: Env,
  ctx: ExecutionContext,
  opts: CreateRunOptions,
): Promise<{ runId: string }> {
  const runId = crypto.randomUUID()
  const bearerToken = crypto.randomUUID()
  const bearerHash = await hashToken(bearerToken)

  await env.DB.prepare(
    `INSERT INTO runs
       (id, repo, pr_number, head_sha, base_sha, trigger, subset_json, status, image_version, bearer_token_hash, triggered_by_user_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', ?8, ?9, ?10)`,
  )
    .bind(
      runId,
      opts.repo,
      opts.prNumber,
      opts.headSha,
      opts.baseSha,
      opts.trigger,
      opts.subset ? JSON.stringify(opts.subset) : null,
      env.RUNNER_IMAGE ?? null,
      bearerHash,
      opts.triggeredByUserId ?? null,
    )
    .run()

  const spec: JobSpec = {
    runId,
    repo: opts.repo,
    prNumber: opts.prNumber,
    headSha: opts.headSha,
    baseSha: opts.baseSha,
    baseRef: opts.baseRef,
    imageVersion: env.RUNNER_IMAGE ?? 'stub',
    subset: opts.subset,
  }
  const { runnerId } = await getRunner(env).spawn(env, ctx, spec, bearerToken)

  await env.DB.prepare('UPDATE runs SET runner_id = ?1 WHERE id = ?2')
    .bind(runnerId, runId)
    .run()

  return { runId }
}
