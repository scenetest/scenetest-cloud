import type { RunEvent, RunSummary } from '@scenetest/protocol'

// Fold a finished run's event log into the report the dashboard widget reads
// for a past run (GET .../runs/:runId). The widget's live view folds the same
// events client-side; this is the server-side counterpart for a run whose
// events have already gone by, so the two must agree on what a scene owns.
//
// Attribution mirrors the widget's `attributeToScene`: prefer the producer's
// stamped scene (`scene` + `teamIndex`, protocol 0.12+), else match on actor
// and time window — the scene of the same team whose [start, end] contains the
// timestamp. Events that attribute to no scene are dropped, exactly as the
// widget drops them.
//
// Kept pure (events in, report out) so every branch is unit-testable without a
// database, an object, or R2.

export interface ReportAssertion {
  result: boolean
  description: string
  actor: string | null
  timestamp: number
}

export interface ReportAction {
  actor: string
  action: string
  target?: string
  duration: number | null
  error: string | null
}

export interface ReportScene {
  name: string
  file: string
  status: string
  duration: number | null
  error: string | null
  team: { name?: string; tags?: Record<string, string> }
  teamIndex: number
  actors: string[]
  assertions: ReportAssertion[]
  timeline: ReportAction[]
}

export interface RunReport {
  runId: string
  status: 'running' | 'finished'
  startTime: number | null
  endTime: number | null
  duration: number | null
  cancelled: boolean
  scenes: ReportScene[]
  summary: {
    scenes: number
    completed: number
    failed: number
    assertions: { total: number; passed: number; failed: number }
    warnings: number
  }
}

// A scene under construction: the report scene plus the window attribution
// needs. `endTime` stays null while the scene is running, which leaves its
// window open-ended — the same rule the widget applies.
interface OpenScene extends ReportScene {
  startTime: number
  endTime: number | null
}

// Unattributed rows, held until every scene:start has been seen. Attribution
// runs at the end so a stamped scene resolves even if the producer's ordering
// puts the row before its scene:start.
interface PendingRow {
  sceneKey: string | null
  actor: string | null
  timestamp: number
}

interface PendingAssertion extends PendingRow {
  assertion: ReportAssertion
}

interface PendingAction extends PendingRow {
  action: ReportAction
}

const sceneKey = (teamIndex: number, name: string) => `${teamIndex}:${name}`

// A run recorded before its producer stamped a field still has to fold. These
// two would otherwise throw or key a scene:end away from its scene:start.
const teamOf = (e: { teamIndex?: number }) => (typeof e.teamIndex === 'number' ? e.teamIndex : 0)
const actorsOf = (e: { actors?: string[] }) => (Array.isArray(e.actors) ? [...e.actors] : [])

// The scene a row belongs to: the stamped key when the producer knows it, else
// the scene whose actors include this actor and whose window contains the
// timestamp. Null when nothing matches (an actor-less assertion on an old run).
function attribute(row: PendingRow, scenes: Map<string, OpenScene>): OpenScene | null {
  if (row.sceneKey !== null) return scenes.get(row.sceneKey) ?? null
  if (row.actor === null) return null
  for (const scene of scenes.values()) {
    if (!scene.actors.includes(row.actor)) continue
    if (row.timestamp < scene.startTime) continue
    if (scene.endTime !== null && row.timestamp > scene.endTime) continue
    return scene
  }
  return null
}

// The stamped scene key, when the producer set both halves of it.
function stampedKey(e: { scene?: string; teamIndex?: number }): string | null {
  return e.scene !== undefined ? sceneKey(teamOf(e), e.scene) : null
}

export function buildRunReport(runId: string, events: RunEvent[]): RunReport {
  const scenes = new Map<string, OpenScene>()
  const assertions: PendingAssertion[] = []
  const actions: PendingAction[] = []
  // An action is reported once, from its `action:start`; the matching
  // `action:end` fills in duration and error. Keyed by actor+action, the same
  // pairing the widget uses.
  const openActions = new Map<string, ReportAction>()
  const openKey = (actor: string, action: string) => JSON.stringify([actor, action])

  let startTime: number | null = null
  let endTime: number | null = null
  let duration: number | null = null
  let cancelled = false
  let warnings = 0
  let sceneCount: number | null = null
  let endSummary: Partial<RunSummary> | null = null

  for (const event of events) {
    switch (event.type) {
      case 'run:start':
        startTime = event.timestamp
        sceneCount = event.sceneCount
        break

      case 'scene:start': {
        const scene: OpenScene = {
          name: event.name,
          file: event.file,
          status: 'running',
          duration: null,
          error: null,
          team: event.team ?? {},
          teamIndex: teamOf(event),
          actors: actorsOf(event),
          assertions: [],
          timeline: [],
          startTime: event.timestamp,
          endTime: null,
        }
        scenes.set(sceneKey(teamOf(event), event.name), scene)
        break
      }

      case 'scene:end': {
        const scene = scenes.get(sceneKey(teamOf(event), event.name))
        if (!scene) break
        scene.status = event.status
        scene.duration = event.duration
        scene.error = event.error ?? null
        scene.endTime = event.timestamp
        break
      }

      case 'action:start': {
        const action: ReportAction = {
          actor: event.actor,
          action: event.action,
          ...(event.target !== undefined ? { target: event.target } : {}),
          duration: null,
          error: null,
        }
        openActions.set(openKey(event.actor, event.action), action)
        actions.push({
          action,
          sceneKey: stampedKey(event),
          actor: event.actor,
          timestamp: event.timestamp,
        })
        break
      }

      case 'action:end': {
        const key = openKey(event.actor, event.action)
        const open = openActions.get(key)
        if (open) {
          // Same action row, now finished: fill it in where it already sits.
          open.duration = event.duration
          open.error = event.error ?? null
          openActions.delete(key)
          break
        }
        // An end with no start (a producer that only reports completed
        // actions, or a log that begins mid-scene): report it on its own.
        actions.push({
          action: {
            actor: event.actor,
            action: event.action,
            ...(event.target !== undefined ? { target: event.target } : {}),
            duration: event.duration,
            error: event.error ?? null,
          },
          sceneKey: stampedKey(event),
          actor: event.actor,
          timestamp: event.timestamp,
        })
        break
      }

      case 'assertion':
        assertions.push({
          assertion: {
            result: event.result,
            description: event.description,
            actor: event.actor ?? null,
            timestamp: event.timestamp,
          },
          sceneKey: stampedKey(event),
          actor: event.actor ?? null,
          timestamp: event.timestamp,
        })
        break

      case 'warning':
        warnings += 1
        break

      case 'run:end':
        endTime = event.timestamp
        duration = event.duration
        cancelled = event.cancelled ?? false
        endSummary = event.summary ?? {}
        break

      default:
        break
    }
  }

  for (const row of assertions) {
    attribute(row, scenes)?.assertions.push(row.assertion)
  }
  for (const row of actions) {
    attribute(row, scenes)?.timeline.push(row.action)
  }

  const list = [...scenes.values()].map(({ startTime: _s, endTime: _e, ...scene }) => scene)

  return {
    runId,
    status: endTime === null ? 'running' : 'finished',
    startTime,
    endTime,
    duration,
    cancelled,
    scenes: list,
    // The producer's own counts win field by field when it sent them: it
    // counted every scene it meant to run, including any whose events never
    // reached us. Anything it left out is counted from the events.
    summary: mergeSummary(countSummary(list, sceneCount, warnings), endSummary),
  }
}

// Counts folded from the events themselves — what a run in flight, or one that
// ended without a run:end, can say about itself.
function countSummary(
  scenes: ReportScene[],
  sceneCount: number | null,
  warnings: number,
): RunReport['summary'] {
  let passed = 0
  let failed = 0
  for (const scene of scenes) {
    for (const a of scene.assertions) {
      if (a.result) passed += 1
      else failed += 1
    }
  }
  return {
    scenes: sceneCount ?? scenes.length,
    completed: scenes.filter((s) => s.status === 'completed').length,
    failed: scenes.filter((s) => s.status === 'failed' || s.status === 'timeout').length,
    assertions: { total: passed + failed, passed, failed },
    warnings,
  }
}

// The producer's `run:end` counts over the folded ones, taking only the numbers
// it actually sent. An older producer sends a partial summary; a run still in
// flight sends none.
function mergeSummary(
  counted: RunReport['summary'],
  reported: Partial<RunSummary> | null,
): RunReport['summary'] {
  if (!reported) return counted
  const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback)
  const a = reported.assertions
  return {
    scenes: num(reported.scenes, counted.scenes),
    completed: num(reported.completed, counted.completed),
    failed: num(reported.failed, counted.failed),
    assertions: {
      total: num(a?.total, counted.assertions.total),
      passed: num(a?.passed, counted.assertions.passed),
      failed: num(a?.failed, counted.assertions.failed),
    },
    warnings: num(reported.warnings, counted.warnings),
  }
}
