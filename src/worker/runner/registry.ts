import type { Env } from '../env.ts'
import type { Runner } from './types.ts'
import { localStubRunner } from './stub.ts'
import { digitalOceanRunner } from './digitalocean.ts'

// Selecting the runner lives here, separate from box.ts and create-run.ts, so
// those two can both reach it without importing each other.
export function getRunner(env: Env): Runner {
  return env.RUNNER_PROVIDER === 'digitalocean' ? digitalOceanRunner : localStubRunner
}
