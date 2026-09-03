import type { Env } from '../env.ts'
import type { RunSpec, Runner } from './types.ts'
import { prCoordinator } from '../do/pr-coordinator.ts'

// LocalStubRunner: fabricates a plausible run by emitting scenetest-shaped
// events into the PR coordinator — the same path a real box's events take. It
// has no real machine, so provision() is a no-op and dispatch() runs the fake
// batch in-worker. A real runner provisions a droplet (provision) and sends
// batches to it over the box's command channel (dispatch) — the Durable Object
// layer. The D1 projections (runs.status, scene_executions) are NOT written
// here: the coordinator derives them from the event stream, so one code path
// serves real and stub runs (issue #36). The stub only asserts events.
// Wire format documented in packages/scenetest-js/.../dashboard.ts handleEvent().

const FAKE_SCENES = [
  { file: 'specs/login.scene.ts', name: 'logs in with valid credentials', actors: ['Alice'], pass: true },
  { file: 'specs/login.scene.ts', name: 'rejects bad password', actors: ['Alice'], pass: true },
  { file: 'specs/checkout.scene.ts', name: 'completes checkout happy path', actors: ['Buyer', 'Cashier'], pass: false },
  { file: 'specs/dashboard.scene.ts', name: 'renders metrics widgets', actors: ['Viewer'], pass: true },
] as const

// The stub runs one team, so every scene it fabricates carries the same
// team identity — enough for a consumer to key scenes by (team, name).
const TEAM_INDEX = 0
const TEAM = { name: 'default' }

export const localStubRunner: Runner = {
  async provision(_env, _ctx, box, _bearerToken) {
    return { runnerId: `stub-${box.boxId.slice(0, 8)}` }
  },

  async dispatch(env, ctx, run) {
    ctx.waitUntil(runStub(env, run))
  },
}

async function runStub(env: Env, run: RunSpec) {
  const targetScenes = run.subset
    ? FAKE_SCENES.filter((s) => run.subset!.includes(sceneId(s.file, s.name)))
    : FAKE_SCENES

  const startTs = Date.now()
  let seq = 0
  // Every event carries its run id: protocol 0.12 requires it, and the widget
  // keys its runs/scenes collections by it. Stamped here so each emit site
  // states only what is specific to that event.
  const emit = async (event: Record<string, unknown>) => {
    seq += 1
    const payload = { runId: run.runId, ...event }
    await prCoordinator(env, run.repo, run.prNumber).fetch(
      new Request(`https://do/ingest/${encodeURIComponent(run.runId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: [{ seq, payload }] }),
      }),
    )
  }

  // run:start moves the run to 'running' and the per-scene grid fills in — the
  // coordinator projects both from these events.
  await emit({ type: 'run:start', timestamp: startTs, sceneCount: targetScenes.length })

  let pass = 0
  let fail = 0
  let assertionsPassed = 0
  let assertionsFailed = 0
  for (const scene of targetScenes) {
    // Latest wins: a new commit retiring the box cancels this run mid-batch
    // (real boxes get the same signal over their command channel). Stop
    // emitting and leave the remaining scenes queued.
    const current = await env.DB.prepare('SELECT status FROM runs WHERE id = ?1')
      .bind(run.runId)
      .first<{ status: string }>()
    if (current?.status === 'cancelled') return

    const sceneStart = Date.now()
    await emit({
      type: 'scene:start',
      timestamp: sceneStart,
      name: scene.name,
      file: scene.file,
      actors: scene.actors,
      teamIndex: TEAM_INDEX,
      team: TEAM,
    })

    for (const actor of scene.actors) {
      const aStart = Date.now()
      await emit({
        type: 'action:start',
        timestamp: aStart,
        actor,
        action: 'click',
        target: 'button:Submit',
        scene: scene.name,
        teamIndex: TEAM_INDEX,
      })
      await sleep(120)
      await emit({
        type: 'action:end',
        timestamp: Date.now(),
        actor,
        action: 'click',
        duration: Date.now() - aStart,
        scene: scene.name,
        teamIndex: TEAM_INDEX,
      })
    }

    await emit({
      type: 'assertion',
      timestamp: Date.now(),
      actor: scene.actors[0],
      description: 'page loads without errors',
      result: true,
      scene: scene.name,
      teamIndex: TEAM_INDEX,
    })
    assertionsPassed += 1

    if (!scene.pass) {
      await emit({
        type: 'assertion',
        timestamp: Date.now(),
        actor: scene.actors[0],
        description: 'order total is $42.00',
        result: false,
        scene: scene.name,
        teamIndex: TEAM_INDEX,
      })
      assertionsFailed += 1
    }

    const sceneEnd = Date.now()
    const status = scene.pass ? 'completed' : 'failed'
    await emit({
      type: 'scene:end',
      timestamp: sceneEnd,
      name: scene.name,
      status,
      duration: sceneEnd - sceneStart,
      error: scene.pass ? undefined : 'Expected $42.00, got $0.00',
      teamIndex: TEAM_INDEX,
      team: TEAM,
    })

    if (scene.pass) pass += 1
    else fail += 1
  }

  const endTs = Date.now()
  await emit({
    type: 'run:end',
    timestamp: endTs,
    duration: endTs - startTs,
    summary: {
      scenes: targetScenes.length,
      completed: pass,
      failed: fail,
      assertions: {
        total: assertionsPassed + assertionsFailed,
        passed: assertionsPassed,
        failed: assertionsFailed,
      },
      warnings: 0,
      consoleErrors: 0,
    },
  })

  // run:end settles the verdict (passed/failed) via the coordinator's
  // projection writer — the same path a real box's run:end takes.

  // Mirror the real box's end-of-run step: ask the PR object to flush its log
  // to the durable R2 artifact. The cancelled-mid-batch early return above
  // skips this; the cron archive backstop covers it. Already inside
  // dispatch()'s waitUntil, so awaiting is fine.
  await prCoordinator(env, run.repo, run.prNumber)
    .fetch('https://do/archive', { method: 'POST', body: JSON.stringify({ runId: run.runId }) })
    .catch((err) =>
      console.error(`artifact(${run.runId}) failed: ${err instanceof Error ? err.message : err}`),
    )
}

function sceneId(file: string, name: string): string {
  return `${file}:${name}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
