import type { Env } from '../env.ts'
import type { BoxSpec } from './types.ts'
import { hashToken } from '../middleware/bearer.ts'
import { advanceImageBuilds, ensureImage } from './image.ts'
import { provisionDroplet, reapRunners } from './digitalocean.ts'
import { sweepArtifacts } from '../artifacts.ts'

// The scheduled heartbeat (wrangler.toml [triggers]): walk every async chain
// forward one step. Order matters — builds first (they may unblock boxes),
// then pending boxes, then the reaper.
export async function tick(env: Env): Promise<void> {
  // Event-log durability is provider-independent: the stub provider writes to
  // D1 just like a real box, so the artifact/prune sweep runs first, before
  // the DigitalOcean-only provisioning machinery early-returns below.
  await sweepArtifacts(env).catch((err) => {
    console.error(`tick: sweep failed: ${err instanceof Error ? err.message : err}`)
  })
  if (env.RUNNER_PROVIDER !== 'digitalocean' || !env.DO_API_TOKEN) return
  await advanceImageBuilds(env)
  await provisionPendingBoxes(env)
  await reapRunners(env)
}

// Boxes whose provision() went pending (image was still building): give each
// a droplet now that the image is ready. The original bearer token's
// plaintext is gone (only its hash is stored), so a fresh token is minted
// and the hash replaced — sound because no machine ever held the old one.
async function provisionPendingBoxes(env: Env): Promise<void> {
  const image = await ensureImage(env).catch((err) => {
    console.error(`tick: ${err instanceof Error ? err.message : err}`)
    return null
  })
  if (!image || !('ready' in image)) return

  const rows = await env.DB.prepare(
    `SELECT b.id, b.repo, b.pr_number, b.head_sha, p.base_ref,
            (SELECT r.base_sha FROM runs r WHERE r.box_id = b.id ORDER BY rowid DESC LIMIT 1) AS base_sha
       FROM boxes b JOIN prs p ON p.repo = b.repo AND p.pr_number = b.pr_number
     WHERE b.status = 'provisioning' AND b.runner_instance_id IS NULL`,
  ).all<{ id: string; repo: string; pr_number: number; head_sha: string; base_ref: string; base_sha: string | null }>()

  for (const row of rows.results ?? []) {
    const bearerToken = crypto.randomUUID()
    await env.DB.prepare('UPDATE boxes SET bearer_token_hash = ?1 WHERE id = ?2')
      .bind(await hashToken(bearerToken), row.id)
      .run()

    const spec: BoxSpec = {
      boxId: row.id,
      repo: row.repo,
      prNumber: row.pr_number,
      headSha: row.head_sha,
      baseSha: row.base_sha,
      baseRef: row.base_ref,
      imageVersion: image.ready,
    }
    try {
      const runnerId = await provisionDroplet(env, spec, bearerToken, image.ready)
      await env.DB.prepare('UPDATE boxes SET runner_instance_id = ?1 WHERE id = ?2')
        .bind(runnerId, row.id)
        .run()
      console.log(`tick: provisioned pending box ${row.id} (droplet ${runnerId})`)
    } catch (err) {
      console.error(`tick: provisioning box ${row.id} failed: ${err instanceof Error ? err.message : err}`)
    }
  }
}
