import type { Env } from '../env.ts'

// A box is provisioned for a PR at a specific commit. Provisioning is
// commit-level (and, eventually, stage-cache-aware); it knows nothing about
// which scenes will run.
export interface BoxSpec {
  boxId: string
  repo: string // 'owner/name'
  prNumber: number
  headSha: string
  baseSha: string | null
  baseRef: string
  imageVersion: string
}

// A run is a batch of scene executions dispatched to an already-provisioned
// box. The subset selects scenes (null = all).
export interface RunSpec {
  runId: string
  boxId: string
  repo: string
  prNumber: number
  headSha: string
  subset: string[] | null
}

export interface Runner {
  // Bring a machine up for the box. Returns the provider instance id, or
  // null when provisioning is pending on something slow (e.g. the runner
  // image still building) — the cron tick completes pending boxes.
  provision(
    env: Env,
    ctx: ExecutionContext,
    box: BoxSpec,
    bearerToken: string,
  ): Promise<{ runnerId: string | null }>

  // Send a batch of scene executions to the box.
  dispatch(env: Env, ctx: ExecutionContext, run: RunSpec): Promise<void>
}
