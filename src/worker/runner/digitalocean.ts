import type { Env } from '../env.ts'
import type { JobSpec, Runner } from './types.ts'

// One ephemeral droplet per run. The droplet image (RUNNER_IMAGE, a snapshot)
// ships the bootstrap: a `scenetest-runner` systemd unit that reads
// /etc/scenetest/run.env, clones the repo at the requested sha, brings up the
// app + db + seeds + Playwright, runs the scenes CLI, and POSTs results to
// the ingest API. user_data only carries the per-run parameters; the image
// contract is documented in docs/runner-provisioning.md.
//
// NOT yet exercised against the live DigitalOcean API.

const DO_API = 'https://api.digitalocean.com/v2'

function doHeaders(env: Env) {
  return {
    authorization: `Bearer ${env.DO_API_TOKEN}`,
    'content-type': 'application/json',
  }
}

function requireConfig(env: Env): string[] {
  return (['DO_API_TOKEN', 'RUNNER_REGION', 'RUNNER_SIZE', 'RUNNER_IMAGE', 'PUBLIC_BASE_URL'] as const)
    .filter((k) => !env[k])
}

function userData(env: Env, spec: JobSpec, bearerToken: string): string {
  // Shell-safe: every value here is either a uuid, a sha, an owner/name pair
  // we resolved against the GitHub API, or JSON we serialized ourselves.
  const runEnv = [
    `SCENETEST_RUN_ID=${spec.runId}`,
    `SCENETEST_REPO=${spec.repo}`,
    `SCENETEST_HEAD_SHA=${spec.headSha}`,
    `SCENETEST_BASE_SHA=${spec.baseSha ?? ''}`,
    `SCENETEST_BASE_REF=${spec.baseRef}`,
    `SCENETEST_SUBSET=${spec.subset ? JSON.stringify(spec.subset) : ''}`,
    `SCENETEST_INGEST_URL=${env.PUBLIC_BASE_URL}`,
    `SCENETEST_BEARER_TOKEN=${bearerToken}`,
  ].join('\n')
  return [
    '#!/bin/bash',
    'mkdir -p /etc/scenetest',
    `cat > /etc/scenetest/run.env <<'EOF'`,
    runEnv,
    'EOF',
    'chmod 600 /etc/scenetest/run.env',
    'systemctl start scenetest-runner',
  ].join('\n')
}

export const digitalOceanRunner: Runner = {
  async spawn(env, _ctx, spec, bearerToken) {
    const missing = requireConfig(env)
    if (missing.length > 0) {
      throw new Error(`digitalocean runner missing config: ${missing.join(', ')}`)
    }

    const resp = await fetch(`${DO_API}/droplets`, {
      method: 'POST',
      headers: doHeaders(env),
      body: JSON.stringify({
        name: `st-runner-${spec.runId.slice(0, 8)}`,
        region: env.RUNNER_REGION,
        size: env.RUNNER_SIZE,
        image: Number.isInteger(Number(env.RUNNER_IMAGE)) ? Number(env.RUNNER_IMAGE) : env.RUNNER_IMAGE,
        user_data: userData(env, spec, bearerToken),
        tags: ['scenetest-runner', `st-run-${spec.runId}`],
        // No ssh_keys: nothing should need to log in. Attach one temporarily
        // via the DO console when debugging an image.
      }),
    })
    if (!resp.ok) {
      throw new Error(`droplet create failed: ${resp.status} ${await resp.text()}`)
    }
    const { droplet } = (await resp.json()) as { droplet: { id: number } }
    const runnerId = String(droplet.id)

    await env.DB.prepare(
      `INSERT INTO runner_instances (id, run_id, provider, region, size, image, status, created_at)
       VALUES (?1, ?2, 'digitalocean', ?3, ?4, ?5, 'provisioning', ?6)`,
    )
      .bind(runnerId, spec.runId, env.RUNNER_REGION!, env.RUNNER_SIZE!, env.RUNNER_IMAGE!, Date.now())
      .run()

    return { runnerId }
  },
}

// 204 means destroyed; 404 means already gone — both leave us in the state
// we want, so both count as success.
export async function destroyDroplet(env: Env, dropletId: string): Promise<boolean> {
  const resp = await fetch(`${DO_API}/droplets/${dropletId}`, {
    method: 'DELETE',
    headers: doHeaders(env),
  })
  return resp.status === 204 || resp.status === 404
}

// Called from the scheduled handler. Destroys instances whose run has ended,
// and instances past the hard age cap (covers hung runs and lost boxes).
export async function reapRunners(env: Env): Promise<void> {
  if (!env.DO_API_TOKEN) return
  const maxAgeMs = Number(env.RUNNER_MAX_AGE_MINUTES ?? '30') * 60_000
  const cutoff = Date.now() - maxAgeMs

  const rows = await env.DB.prepare(
    `SELECT ri.id FROM runner_instances ri
       JOIN runs r ON r.id = ri.run_id
     WHERE ri.provider = 'digitalocean'
       AND ri.status IN ('provisioning', 'active')
       AND (r.ended_at IS NOT NULL OR ri.created_at < ?1)`,
  )
    .bind(cutoff)
    .all<{ id: string }>()

  for (const row of rows.results ?? []) {
    const ok = await destroyDroplet(env, row.id)
    await env.DB.prepare(
      `UPDATE runner_instances SET status = ?1, destroyed_at = ?2 WHERE id = ?3`,
    )
      .bind(ok ? 'destroyed' : 'lost', Date.now(), row.id)
      .run()
    if (!ok) console.error(`reaper: failed to destroy droplet ${row.id}; marked lost`)
  }
}
