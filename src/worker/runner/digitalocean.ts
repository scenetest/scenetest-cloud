import type { Env } from '../env.ts'
import type { BoxSpec, Runner } from './types.ts'
import { prCoordinator } from '../do/pr-coordinator.ts'

// One ephemeral droplet per PR box. The droplet image (RUNNER_IMAGE, a
// snapshot) ships the bootstrap: a `scenetest-runner` systemd unit that reads
// /etc/scenetest/run.env, clones the repo at the box's sha, brings up the
// app + db + seeds + Playwright, and connects out to the PR's coordinator.
// user_data carries only box-level parameters; scene batches arrive later over
// the box's command channel. The image contract is in
// docs/runner-provisioning.md.
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

function userData(env: Env, box: BoxSpec, bearerToken: string): string {
  // Shell-safe: every value here is a uuid, a sha, an owner/name pair resolved
  // against the GitHub API, or a value we control.
  const runEnv = [
    `SCENETEST_BOX_ID=${box.boxId}`,
    `SCENETEST_REPO=${box.repo}`,
    `SCENETEST_HEAD_SHA=${box.headSha}`,
    `SCENETEST_BASE_SHA=${box.baseSha ?? ''}`,
    `SCENETEST_BASE_REF=${box.baseRef}`,
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
  async provision(env, _ctx, box, bearerToken) {
    const missing = requireConfig(env)
    if (missing.length > 0) {
      throw new Error(`digitalocean runner missing config: ${missing.join(', ')}`)
    }

    const resp = await fetch(`${DO_API}/droplets`, {
      method: 'POST',
      headers: doHeaders(env),
      body: JSON.stringify({
        name: `st-box-${box.boxId.slice(0, 8)}`,
        region: env.RUNNER_REGION,
        size: env.RUNNER_SIZE,
        image: Number.isInteger(Number(env.RUNNER_IMAGE)) ? Number(env.RUNNER_IMAGE) : env.RUNNER_IMAGE,
        user_data: userData(env, box, bearerToken),
        tags: ['scenetest-runner', `st-box-${box.boxId}`],
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
      `INSERT INTO runner_instances (id, box_id, provider, region, size, image, status, created_at)
       VALUES (?1, ?2, 'digitalocean', ?3, ?4, ?5, 'provisioning', ?6)`,
    )
      .bind(runnerId, box.boxId, env.RUNNER_REGION!, env.RUNNER_SIZE!, env.RUNNER_IMAGE!, Date.now())
      .run()

    return { runnerId }
  },

  async dispatch(env, _ctx, run) {
    // The batch rides the box's command channel: the PR coordinator sends it
    // down the connected WebSocket, or queues it — the normal case right
    // after provision, when the droplet is still booting. The box receives
    // every queued dispatch the moment it connects.
    await prCoordinator(env, run.repo, run.prNumber).fetch('https://do/dispatch', {
      method: 'POST',
      body: JSON.stringify({ run }),
    })
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

// Called from the scheduled handler. Destroys droplets whose box is retired
// (status 'destroyed') and droplets past the hard age cap (covers hung builds
// and lost boxes). A box reaped purely on age was never reported ready/idle,
// so its still-running runs are cancelled here — otherwise their status would
// stay 'running' forever after the box is gone.
export async function reapRunners(env: Env): Promise<void> {
  if (!env.DO_API_TOKEN) return
  const maxAgeMs = Number(env.RUNNER_MAX_AGE_MINUTES ?? '30') * 60_000
  const cutoff = Date.now() - maxAgeMs

  const rows = await env.DB.prepare(
    `SELECT ri.id, ri.box_id, b.status AS box_status FROM runner_instances ri
       JOIN boxes b ON b.id = ri.box_id
     WHERE ri.provider = 'digitalocean'
       AND ri.status IN ('provisioning', 'active')
       AND (b.status = 'destroyed' OR ri.created_at < ?1)`,
  )
    .bind(cutoff)
    .all<{ id: string; box_id: string; box_status: string }>()

  for (const row of rows.results ?? []) {
    const ok = await destroyDroplet(env, row.id)
    const now = Date.now()
    await env.DB.prepare(
      `UPDATE runner_instances SET status = ?1, destroyed_at = ?2 WHERE id = ?3`,
    )
      .bind(ok ? 'destroyed' : 'lost', now, row.id)
      .run()
    if (row.box_status !== 'destroyed') {
      await env.DB.prepare(
        `UPDATE boxes SET status = 'destroyed', destroyed_at = ?1 WHERE id = ?2`,
      )
        .bind(now, row.box_id)
        .run()
    }
    // Cancel any of the box's runs that never completed.
    await env.DB.prepare(
      `UPDATE runs SET status = 'cancelled', ended_at = ?1
         WHERE box_id = ?2 AND ended_at IS NULL`,
    )
      .bind(now, row.box_id)
      .run()
    if (!ok) console.error(`reaper: failed to destroy droplet ${row.id}; marked lost`)
  }
}
