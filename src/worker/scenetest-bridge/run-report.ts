import type { RunEvent } from '@scenetest/protocol'
import {
  actionsProjection,
  assertionsProjection,
  attributeToScene,
  runsProjection,
  scenesProjection,
  type RunProjection,
  type SceneRow,
} from '@scenetest/dashboard/collections'

// Fold a run's event log into the report the dashboard widget reads for a past
// run (GET .../runs/:runId), shaped for its `mapReportToSnapshot`.
//
// The fold is the widget's own: `@scenetest/dashboard/collections` exports the
// projections it folds live events with, and they are pure — no Preact, no
// TanStack DB — so the worker drives the same functions over a stored log. A
// second implementation here would be two folds of one log that have to agree,
// and they would drift on the first upstream release.
//
// What is left is the shaping the widget does in `selectSnapshot`: attribute
// each assertion and action to its scene, then roll up the summary. That is
// mirrored below rather than imported, because it ships from the package root,
// which pulls in Preact.

// One row per scene, carrying what it owns. `mapReportToSnapshot` reads exactly
// these fields.
export interface ReportScene {
  name: string
  file: string
  status: string
  duration: number | null
  error: string | null
  team: SceneRow['team']
  teamIndex: number
  actors: string[]
  assertions: Array<{
    result: boolean
    description: string
    actor: string | null
    timestamp: number
  }>
  timeline: Array<{
    actor: string
    action: string
    target?: string
    duration: number | null
    error: string | null
  }>
}

export interface RunReport {
  scenes: ReportScene[]
  summary: {
    scenes: number
    completed: number
    failed: number
    assertions: { total: number; passed: number; failed: number }
    warnings: number
  }
}

// A row the fold can attribute to a scene: stamped `sceneId` when the producer
// named the scene, else actor and timestamp for the window match.
interface Attributable {
  sceneId: string | null
  runId: string
  actor: string | null
  timestamp: number
}

export function buildRunReport(events: RunEvent[]): RunReport {
  const scenes = fold(scenesProjection(), events)
  const assertions = fold(assertionsProjection(), events)
  const actions = fold(actionsProjection(), events)
  // One run's log folds to one run row. Absent when the log starts mid-run,
  // which is why every count below has a fallback.
  const run = fold(runsProjection(), events)[0]

  let warnings = 0
  for (const event of events) if (event.type === 'warning') warnings += 1

  const assertionsByScene = groupByScene(assertions, scenes)
  const actionsByScene = groupByScene(actions, scenes)

  const view: ReportScene[] = scenes.map((scene) => ({
    name: scene.name,
    file: scene.file,
    status: scene.status,
    duration: scene.duration,
    error: scene.error,
    team: scene.team,
    teamIndex: scene.teamIndex,
    actors: scene.actors,
    assertions: (assertionsByScene.get(scene.id) ?? []).map((a) => ({
      result: a.result,
      description: a.description,
      actor: a.actor,
      timestamp: a.timestamp,
    })),
    timeline: (actionsByScene.get(scene.id) ?? [])
      .slice()
      .sort((a, b) => a.startTime - b.startTime)
      .map((action) => ({
        actor: action.actor,
        action: action.status === 'running' ? `${action.action} (in flight)` : action.action,
        ...(action.target !== null ? { target: action.target } : {}),
        duration: action.duration,
        error: action.error,
      })),
  }))

  return {
    scenes: view,
    // The run's own counts win where it reported them — it counted every scene
    // it meant to run, including any whose events never reached us. Assertions
    // count every row of the run, attributed to a scene or not, so the total
    // matches what the live view shows for the same log.
    summary: {
      scenes: Math.max(run?.sceneCount ?? 0, view.length),
      completed: run?.completed ?? view.filter((s) => s.status === 'completed').length,
      failed:
        run?.failed ?? view.filter((s) => s.status !== 'completed' && s.status !== 'running').length,
      assertions: {
        total: assertions.length,
        passed: assertions.filter((a) => a.result).length,
        failed: assertions.filter((a) => !a.result).length,
      },
      warnings,
    },
  }
}

// Drive one of the widget's projections over the log, in order, and return its
// rows. A projection that throws on an event — an older producer omitting a
// field it reads — costs that one event, not the report.
function fold<T extends object>(projection: RunProjection<T, string>, events: RunEvent[]): T[] {
  const rows = new Map<string, T>()
  for (const event of events) {
    let ops
    try {
      ops = projection.project(event, (key) => rows.get(key))
    } catch {
      continue
    }
    for (const op of ops) {
      if (op.type === 'reset') rows.clear()
      else if (op.type === 'delete') rows.delete(op.key)
      else rows.set(projection.getKey(op.value), op.value)
    }
  }
  return [...rows.values()]
}

// Bucket rows by the scene they belong to, one pass. An unstamped row is
// matched on actor and time window, so it is only compared against the scenes
// that actor appears in rather than every scene of the run.
function groupByScene<T extends Attributable>(rows: T[], scenes: SceneRow[]): Map<string, T[]> {
  const byActor = new Map<string, SceneRow[]>()
  for (const scene of scenes) {
    for (const actor of scene.actors) {
      const seen = byActor.get(actor)
      if (seen) seen.push(scene)
      else byActor.set(actor, [scene])
    }
  }

  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const sceneId = attributeToScene(row, row.actor ? byActor.get(row.actor) ?? [] : [])
    if (sceneId === null) continue
    const seen = grouped.get(sceneId)
    if (seen) seen.push(row)
    else grouped.set(sceneId, [row])
  }
  return grouped
}
