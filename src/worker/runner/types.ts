import type { Env } from '../env.ts'

export interface JobSpec {
  runId: string
  prNumber: number
  headSha: string
  baseSha: string | null
  baseRef: string
  imageVersion: string
  subset: string[] | null // scene_ids to run, null = all
}

export interface Runner {
  spawn(env: Env, ctx: ExecutionContext, spec: JobSpec, bearerToken: string): Promise<{ runnerId: string }>
}
