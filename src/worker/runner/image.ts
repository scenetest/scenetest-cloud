import type { Env } from '../env.ts'
import { doApi, destroyDroplet, dropletStatus } from './do-api.ts'
// Imported as text (wrangler [[rules]]): these are inputs to the image, so
// their content is part of the stage hash — editing the agent or the
// builder script builds a new image.
import builderSetupTemplate from './image/builder-setup.sh'
import agentSource from '../../../infra/box/agent.mjs'

// The env-image stage of the build pipeline (architecture.md), realized as
// a DigitalOcean snapshot: build from a stock Ubuntu image on first need,
// cache the snapshot id in stage_cache keyed by a content hash of the
// inputs, reuse it for every box until an input changes. One global default
// toolchain for now; per-project overrides arrive with the pipeline-config
// format.
//
// Workers can't wait out a 10–15 minute build, so this is a state machine:
// ensureImage() returns ready-or-building and kicks a build on a miss;
// advanceImageBuilds() (cron) walks builder droplets through
// off → snapshot → ready and the tick then provisions waiting boxes.
// Builder bookkeeping lives in the stage_cache row's report_json.

export const IMAGE_CONFIG = {
  base: 'ubuntu-24-04-x64',
  nodeMajor: '22',
  supabaseCliVersion: '2.30.4',
} as const

const BUILD_TIMEOUT_MS = 40 * 60_000
const MAX_ATTEMPTS = 3

interface BuildBook {
  builderId: number
  attempts: number
  startedAt: number
  snapshotActionId?: number
}

let cachedHash: string | null = null
export async function imageStageHash(): Promise<string> {
  if (cachedHash) return cachedHash
  const input = JSON.stringify(IMAGE_CONFIG) + builderSetupTemplate + agentSource
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  cachedHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
  return cachedHash
}

function builderUserData(): string {
  const agentB64 = btoa(String.fromCharCode(...new TextEncoder().encode(agentSource)))
  return builderSetupTemplate
    .replaceAll('__AGENT_B64__', agentB64)
    .replaceAll('__NODE_MAJOR__', IMAGE_CONFIG.nodeMajor)
    .replaceAll('__SUPABASE_CLI_VERSION__', IMAGE_CONFIG.supabaseCliVersion)
}

export type ImageState = { ready: string } | { building: true }

// Returns the snapshot to provision boxes from, or kicks off a build.
// RUNNER_IMAGE, when set, is an explicit pin that bypasses the cache — the
// escape hatch for "the self-built image is broken, use this one".
export async function ensureImage(env: Env): Promise<ImageState> {
  if (env.RUNNER_IMAGE) return { ready: env.RUNNER_IMAGE }
  const hash = await imageStageHash()

  const row = await env.DB.prepare(
    'SELECT status, artifact_ref, report_json FROM stage_cache WHERE stage = ?1 AND input_hash = ?2',
  )
    .bind('image', hash)
    .first<{ status: string; artifact_ref: string | null; report_json: string | null }>()

  if (row?.status === 'ready' && row.artifact_ref) {
    await env.DB.prepare(
      'UPDATE stage_cache SET last_hit_at = ?1 WHERE stage = ?2 AND input_hash = ?3',
    )
      .bind(Date.now(), 'image', hash)
      .run()
    return { ready: row.artifact_ref }
  }
  if (row?.status === 'building') return { building: true }

  const attempts = row?.report_json ? ((JSON.parse(row.report_json) as BuildBook).attempts ?? 0) : 0
  if (row?.status === 'failed' && attempts >= MAX_ATTEMPTS) {
    throw new Error(
      `image build failed ${attempts}x for hash ${hash}; pin RUNNER_IMAGE or delete the stage_cache row to retry`,
    )
  }

  const { droplet } = await doApi<{ droplet: { id: number } }>(env, 'POST', '/droplets', {
    name: `st-img-builder-${hash.slice(0, 8)}`,
    region: env.RUNNER_REGION,
    size: env.RUNNER_SIZE,
    image: IMAGE_CONFIG.base,
    user_data: builderUserData(),
    tags: ['scenetest-image-builder'],
  })
  const book: BuildBook = { builderId: droplet.id, attempts: attempts + 1, startedAt: Date.now() }
  await env.DB.prepare(
    `INSERT INTO stage_cache (stage, input_hash, status, report_json, created_at)
     VALUES ('image', ?1, 'building', ?2, ?3)
     ON CONFLICT(stage, input_hash) DO UPDATE SET status = 'building', report_json = ?2`,
  )
    .bind(hash, JSON.stringify(book), Date.now())
    .run()
  console.log(`image build kicked: hash ${hash}, builder droplet ${droplet.id}, attempt ${book.attempts}`)
  return { building: true }
}

// Cron: walk in-flight builds forward one step per tick.
export async function advanceImageBuilds(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT input_hash, report_json FROM stage_cache WHERE stage = 'image' AND status = 'building'",
  ).all<{ input_hash: string; report_json: string | null }>()

  for (const row of rows.results ?? []) {
    const book = JSON.parse(row.report_json ?? '{}') as BuildBook
    try {
      await advanceOne(env, row.input_hash, book)
    } catch (err) {
      console.error(`image build ${row.input_hash}: ${err instanceof Error ? err.message : err}`)
    }
  }
}

async function advanceOne(env: Env, hash: string, book: BuildBook): Promise<void> {
  const fail = async (reason: string) => {
    console.error(`image build ${hash} failed: ${reason}`)
    await destroyDroplet(env, book.builderId)
    await env.DB.prepare(
      "UPDATE stage_cache SET status = 'failed', report_json = ?1 WHERE stage = 'image' AND input_hash = ?2",
    )
      .bind(JSON.stringify(book), hash)
      .run()
  }

  if (!book.snapshotActionId) {
    const status = await dropletStatus(env, book.builderId)
    if (status === null) return fail('builder droplet vanished')
    if (status !== 'off') {
      if (Date.now() - book.startedAt > BUILD_TIMEOUT_MS) return fail('builder never powered off')
      return // still installing; check again next tick
    }
    // Powered off = setup finished. Snapshot it.
    const { action } = await doApi<{ action: { id: number } }>(
      env, 'POST', `/droplets/${book.builderId}/actions`,
      { type: 'snapshot', name: `st-img-${hash}` },
    )
    book.snapshotActionId = action.id
    await env.DB.prepare(
      "UPDATE stage_cache SET report_json = ?1 WHERE stage = 'image' AND input_hash = ?2",
    )
      .bind(JSON.stringify(book), hash)
      .run()
    return
  }

  const { action } = await doApi<{ action: { status: string } }>(
    env, 'GET', `/actions/${book.snapshotActionId}`,
  )
  if (action.status === 'errored') return fail('snapshot action errored')
  if (action.status !== 'completed') return // snapshotting; next tick

  const { snapshots } = await doApi<{ snapshots: Array<{ id: number; created_at: string }> }>(
    env, 'GET', `/droplets/${book.builderId}/snapshots`,
  )
  const latest = snapshots.sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1)
  if (!latest) return fail('snapshot completed but none found')

  await env.DB.prepare(
    `UPDATE stage_cache SET status = 'ready', artifact_ref = ?1, report_json = ?2
     WHERE stage = 'image' AND input_hash = ?3`,
  )
    .bind(String(latest.id), JSON.stringify(book), hash)
    .run()
  await destroyDroplet(env, book.builderId)
  console.log(`image build ${hash} ready: snapshot ${latest.id}`)
}
