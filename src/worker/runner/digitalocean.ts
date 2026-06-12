import type { Env } from '../env.ts'
import type { BoxSpec, Runner } from './types.ts'
import { prCoordinator } from '../do/pr-coordinator.ts'
import { doApi, destroyDroplet } from './do-api.ts'
import { ensureImage } from './image.ts'

// One ephemeral droplet per PR box, created from the self-built runner
// snapshot (src/worker/runner/image.ts). The image ships the box agent
// (infra/box/agent.mjs) behind a disabled systemd unit; the user_data here
// carries only the per-box parameters, writes /etc/scenetest/run.env, and
// starts the unit.
//
// Provisioning is allowed to go PENDING: on the first run ever (or after a
// toolchain change) the image is still building, so provision() returns a
// null runnerId, the box row sits in 'provisioning' with no instance, and
// the cron tick completes it once the snapshot is ready. Dispatches queue
// in the PR coordinator throughout, so nothing is lost by the wait.
//
// NOT yet exercised against the live DigitalOcean API.

function requireConfig(env: Env): string[] {
  return (['DO_API_TOKEN', 'RUNNER_REGION', 'RUNNER_SIZE', 'PUBLIC_BASE_URL'] as const)
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

// DigitalOcean tags allow letters, numbers, colons, dashes, and underscores.
// Colon is the separator since it can't appear in GitHub owner/repo names;
// anything else illegal (the '/' in 'owner/name') becomes a dash.
function doTag(...parts: Array<string | number>): string {
  return parts.map((p) => String(p).replace(/[^A-Za-z0-9_-]/g, '-')).join(':').slice(0, 255)
}

export function boxTags(box: BoxSpec): string[] {
  return [
    'scenetest-runner',
    `st-box-${box.boxId}`,
    doTag('st-repo', box.repo),
    doTag('st-pr', box.repo, box.prNumber),
  ]
}

// Create the droplet for a box from a ready image. Shared by the inline
// provision path and the cron's pending-box completion.
export async function provisionDroplet(
  env: Env,
  box: BoxSpec,
  bearerToken: string,
  imageId: string,
): Promise<string> {
  const { droplet } = await doApi<{ droplet: { id: number } }>(env, 'POST', '/droplets', {
    name: `st-box-${box.boxId.slice(0, 8)}`,
    region: env.RUNNER_REGION,
    size: env.RUNNER_SIZE,
    image: Number.isInteger(Number(imageId)) ? Number(imageId) : imageId,
    user_data: userData(env, box, bearerToken),
    tags: boxTags(box),
    // No ssh_keys: nothing should need to log in. Attach one temporarily
    // via the DO console when debugging an image.
  })
  const runnerId = String(droplet.id)

  await env.DB.prepare(
    `INSERT INTO runner_instances (id, box_id, provider, region, size, image, status, created_at)
     VALUES (?1, ?2, 'digitalocean', ?3, ?4, ?5, 'provisioning', ?6)`,
  )
    .bind(runnerId, box.boxId, env.RUNNER_REGION!, env.RUNNER_SIZE!, imageId, Date.now())
    .run()

  return runnerId
}

export const digitalOceanRunner: Runner = {
  async provision(env, _ctx, box, bearerToken) {
    const missing = requireConfig(env)
    if (missing.length > 0) {
      throw new Error(`digitalocean runner missing config: ${missing.join(', ')}`)
    }

    const image = await ensureImage(env)
    if (!('ready' in image)) {
      // Image still building; the tick provisions this box when it's done.
      return { runnerId: null }
    }
    return { runnerId: await provisionDroplet(env, box, bearerToken, image.ready) }
  },

  async dispatch(env, _ctx, run) {
    // The batch rides the box's command channel: the PR coordinator sends it
    // down the connected WebSocket, or queues it — the normal case right
    // after provision, when the droplet is still booting (or the image is
    // still building). The box receives every queued dispatch on connect.
    await prCoordinator(env, run.repo, run.prNumber).fetch('https://do/dispatch', {
      method: 'POST',
      body: JSON.stringify({ run }),
    })
  },
}

// Called from the scheduled tick. Destroys droplets whose box is retired
// (status 'destroyed') and droplets past the hard age cap (covers hung
// builds and lost boxes), and cancels any of the box's runs that never
// completed — otherwise their status would stay 'running' forever after
// the box is gone.
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
