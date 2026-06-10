import type { Env } from '../env.ts'
import type { JobSpec, Runner } from './types.ts'

// LocalStubRunner: writes scenetest-shaped events + scene_executions directly to D1.
// In production a real runner would POST via HTTP and authenticate with the bearer.
// Wire format documented in packages/scenetest-js/.../dashboard.ts handleEvent().

const FAKE_SCENES = [
  { file: 'specs/login.scene.ts', name: 'logs in with valid credentials', actors: ['Alice'], pass: true },
  { file: 'specs/login.scene.ts', name: 'rejects bad password', actors: ['Alice'], pass: true },
  { file: 'specs/checkout.scene.ts', name: 'completes checkout happy path', actors: ['Buyer', 'Cashier'], pass: false },
  { file: 'specs/dashboard.scene.ts', name: 'renders metrics widgets', actors: ['Viewer'], pass: true },
] as const

export const localStubRunner: Runner = {
  async spawn(env, ctx, spec, _bearerToken) {
    const runnerId = `stub-${crypto.randomUUID()}`
    ctx.waitUntil(runStub(env, spec, runnerId))
    return { runnerId }
  },
}

async function runStub(env: Env, spec: JobSpec, runnerId: string) {
  const targetScenes = spec.subset
    ? FAKE_SCENES.filter((s) => spec.subset!.includes(sceneId(s.file, s.name)))
    : FAKE_SCENES

  const startTs = Date.now()
  let seq = 0
  const insertEvent = env.DB.prepare(
    'INSERT INTO events (run_id, seq, payload, ts) VALUES (?1, ?2, ?3, ?4)',
  )
  const emit = async (payload: unknown) => {
    seq += 1
    await insertEvent.bind(spec.runId, seq, JSON.stringify(payload), Date.now()).run()
  }

  await env.DB.prepare(
    'UPDATE runs SET status = ?1, started_at = ?2, runner_id = ?3 WHERE id = ?4',
  )
    .bind('running', startTs, runnerId, spec.runId)
    .run()

  await emit({ type: 'run:start', timestamp: startTs, sceneCount: targetScenes.length })

  // Seed scene_executions as queued.
  const seedStmt = env.DB.prepare(
    `INSERT INTO scene_executions
       (id, run_id, repo, pr_number, scene_id, scene_file, scene_name, head_sha, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued')`,
  )
  await env.DB.batch(
    targetScenes.map((s) =>
      seedStmt.bind(
        crypto.randomUUID(),
        spec.runId,
        spec.repo,
        spec.prNumber,
        sceneId(s.file, s.name),
        s.file,
        s.name,
        spec.headSha,
      ),
    ),
  )

  let pass = 0
  let fail = 0
  for (const scene of targetScenes) {
    const sId = sceneId(scene.file, scene.name)
    const sceneStart = Date.now()
    await env.DB.prepare(
      `UPDATE scene_executions SET status = 'running', started_at = ?1
         WHERE run_id = ?2 AND scene_id = ?3`,
    )
      .bind(sceneStart, spec.runId, sId)
      .run()

    await emit({
      type: 'scene:start',
      timestamp: sceneStart,
      name: scene.name,
      file: scene.file,
      actors: scene.actors,
    })

    for (const actor of scene.actors) {
      const aStart = Date.now()
      await emit({
        type: 'action:start',
        timestamp: aStart,
        actor,
        action: 'click',
        target: 'button:Submit',
      })
      await sleep(120)
      await emit({
        type: 'action:end',
        timestamp: Date.now(),
        actor,
        action: 'click',
        duration: Date.now() - aStart,
        error: null,
      })
    }

    await emit({
      type: 'assertion',
      timestamp: Date.now(),
      actor: scene.actors[0],
      description: 'page loads without errors',
      result: 'passed',
    })

    if (!scene.pass) {
      await emit({
        type: 'assertion',
        timestamp: Date.now(),
        actor: scene.actors[0],
        description: 'order total is $42.00',
        result: 'failed',
      })
    }

    const sceneEnd = Date.now()
    const status = scene.pass ? 'completed' : 'failed'
    await emit({
      type: 'scene:end',
      timestamp: sceneEnd,
      status,
      duration: sceneEnd - sceneStart,
      error: scene.pass ? undefined : { message: 'Expected $42.00, got $0.00' },
    })

    await env.DB.prepare(
      `UPDATE scene_executions SET status = ?1, ended_at = ?2 WHERE run_id = ?3 AND scene_id = ?4`,
    )
      .bind(scene.pass ? 'passed' : 'failed', sceneEnd, spec.runId, sId)
      .run()

    if (scene.pass) pass += 1
    else fail += 1
  }

  const endTs = Date.now()
  await emit({
    type: 'run:end',
    timestamp: endTs,
    duration: endTs - startTs,
    summary: { scenes: targetScenes.length, completed: pass, failed: fail },
  })

  await env.DB.prepare(
    `UPDATE runs SET status = ?1, ended_at = ?2 WHERE id = ?3`,
  )
    .bind(fail === 0 ? 'passed' : 'failed', endTs, spec.runId)
    .run()
}

function sceneId(file: string, name: string): string {
  return `${file}:${name}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
