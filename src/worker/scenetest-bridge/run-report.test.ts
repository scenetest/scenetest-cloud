import { describe, it, expect } from 'vitest'
import type { RunEvent } from '@scenetest/protocol'
import { buildRunReport } from './run-report.ts'

const RUN = 'run-1'
const TEAM = { name: 'default' }

// A whole run in the shape a current CLI produces: stamped runId, stamped
// owning scene on every action and assertion.
function stampedRun(): RunEvent[] {
  return [
    { type: 'run:start', timestamp: 100, runId: RUN, sceneCount: 2 },
    {
      type: 'scene:start', timestamp: 110, runId: RUN, name: 'logs in',
      file: 'login.scene.ts', actors: ['Alice'], teamIndex: 0, team: TEAM,
    },
    {
      type: 'action:start', timestamp: 120, runId: RUN, actor: 'Alice',
      action: 'click', target: 'button:Submit', scene: 'logs in', teamIndex: 0,
    },
    {
      type: 'action:end', timestamp: 130, runId: RUN, actor: 'Alice',
      action: 'click', duration: 10, scene: 'logs in', teamIndex: 0,
    },
    {
      type: 'assertion', timestamp: 135, runId: RUN, actor: 'Alice',
      description: 'greeting shows', result: true, scene: 'logs in', teamIndex: 0,
    },
    {
      type: 'scene:end', timestamp: 140, runId: RUN, name: 'logs in',
      status: 'completed', duration: 30, teamIndex: 0, team: TEAM,
    },
    {
      type: 'scene:start', timestamp: 150, runId: RUN, name: 'checks out',
      file: 'checkout.scene.ts', actors: ['Buyer'], teamIndex: 0, team: TEAM,
    },
    {
      type: 'assertion', timestamp: 155, runId: RUN, actor: 'Buyer',
      description: 'total is $42', result: false, scene: 'checks out', teamIndex: 0,
    },
    {
      type: 'scene:end', timestamp: 160, runId: RUN, name: 'checks out',
      status: 'failed', duration: 10, error: 'Expected $42.00', teamIndex: 0, team: TEAM,
    },
    {
      type: 'run:end', timestamp: 170, runId: RUN, duration: 70,
      summary: {
        scenes: 2, completed: 1, failed: 1,
        assertions: { total: 2, passed: 1, failed: 1 }, warnings: 0, consoleErrors: 0,
      },
    },
  ]
}

describe('buildRunReport', () => {
  it('folds scenes with their assertions and timeline', () => {
    const report = buildRunReport(RUN, stampedRun())

    expect(report.scenes.map((s) => s.name)).toEqual(['logs in', 'checks out'])
    const [login, checkout] = report.scenes
    expect(login).toMatchObject({
      file: 'login.scene.ts', status: 'completed', duration: 30, error: null,
      teamIndex: 0, team: TEAM, actors: ['Alice'],
    })
    expect(login!.assertions).toEqual([
      { result: true, description: 'greeting shows', actor: 'Alice', timestamp: 135 },
    ])
    expect(login!.timeline).toEqual([
      { actor: 'Alice', action: 'click', target: 'button:Submit', duration: 10, error: null },
    ])
    expect(checkout).toMatchObject({ status: 'failed', error: 'Expected $42.00' })
  })

  it('reports the run as finished, with the producer’s own summary', () => {
    const report = buildRunReport(RUN, stampedRun())
    expect(report).toMatchObject({
      runId: RUN, status: 'finished', startTime: 100, endTime: 170, duration: 70, cancelled: false,
    })
    expect(report.summary).toEqual({
      scenes: 2, completed: 1, failed: 1,
      assertions: { total: 2, passed: 1, failed: 1 }, warnings: 0,
    })
  })

  it('pairs an action:start with its action:end once, not twice', () => {
    const report = buildRunReport(RUN, stampedRun())
    expect(report.scenes[0]!.timeline).toHaveLength(1)
  })

  it('carries an action error through to the timeline', () => {
    const events = stampedRun()
    const end = events.find((e) => e.type === 'action:end')!
    Object.assign(end, { error: 'element not found' })
    const report = buildRunReport(RUN, events)
    expect(report.scenes[0]!.timeline[0]!.error).toBe('element not found')
  })

  it('leaves an unfinished action in the timeline with no duration', () => {
    const events = stampedRun().filter((e) => e.type !== 'action:end')
    const report = buildRunReport(RUN, events)
    expect(report.scenes[0]!.timeline).toEqual([
      { actor: 'Alice', action: 'click', target: 'button:Submit', duration: null, error: null },
    ])
  })

  it('reports a run with no run:end as still running, counting what it saw', () => {
    const events = stampedRun().filter((e) => e.type !== 'run:end')
    const report = buildRunReport(RUN, events)
    expect(report).toMatchObject({ status: 'running', endTime: null, duration: null })
    // sceneCount comes from run:start; the rest is counted from the scenes.
    expect(report.summary).toEqual({
      scenes: 2, completed: 1, failed: 1,
      assertions: { total: 2, passed: 1, failed: 1 }, warnings: 0,
    })
  })

  it('marks a stopped run cancelled', () => {
    const events = stampedRun()
    const end = events.find((e) => e.type === 'run:end')!
    Object.assign(end, { cancelled: true })
    expect(buildRunReport(RUN, events).cancelled).toBe(true)
  })

  it('counts warnings the producer did not summarize', () => {
    const events = stampedRun().filter((e) => e.type !== 'run:end')
    events.push({
      type: 'warning', timestamp: 156, runId: RUN, actor: 'Buyer',
      selector: '#total', message: 'selector matched twice',
    })
    expect(buildRunReport(RUN, events).summary.warnings).toBe(1)
  })

  // Older producers stamp neither the owning scene nor a runId. The fold has to
  // attribute those rows by actor and time window, the way the widget does.
  it('attributes unstamped rows by actor and time window', () => {
    const events = stampedRun().map((e) => {
      const { scene: _scene, ...rest } = e as RunEvent & { scene?: string }
      return rest as RunEvent
    })
    const report = buildRunReport(RUN, events)
    expect(report.scenes[0]!.assertions.map((a) => a.description)).toEqual(['greeting shows'])
    expect(report.scenes[1]!.assertions.map((a) => a.description)).toEqual(['total is $42'])
    expect(report.scenes[0]!.timeline).toHaveLength(1)
  })

  it('drops a row that attributes to no scene', () => {
    const events = stampedRun()
    events.push({
      type: 'assertion', timestamp: 9999, runId: RUN,
      description: 'no actor, no scene, long after the run', result: true,
    })
    const report = buildRunReport(RUN, events)
    expect(report.scenes.flatMap((s) => s.assertions)).toHaveLength(2)
  })

  it('folds a scene whose producer omitted teamIndex', () => {
    const events: RunEvent[] = [
      { type: 'run:start', timestamp: 1, runId: RUN, sceneCount: 1 },
      {
        type: 'scene:start', timestamp: 2, runId: RUN, name: 'legacy',
        file: 'a.scene.ts', actors: ['A'],
      } as unknown as RunEvent,
      {
        type: 'scene:end', timestamp: 3, runId: RUN, name: 'legacy',
        status: 'completed', duration: 1,
      } as unknown as RunEvent,
    ]
    const report = buildRunReport(RUN, events)
    expect(report.scenes).toHaveLength(1)
    expect(report.scenes[0]).toMatchObject({ name: 'legacy', status: 'completed', teamIndex: 0 })
  })

  it('returns an empty report for a run with no events', () => {
    const report = buildRunReport(RUN, [])
    expect(report.scenes).toEqual([])
    expect(report.summary).toEqual({
      scenes: 0, completed: 0, failed: 0,
      assertions: { total: 0, passed: 0, failed: 0 }, warnings: 0,
    })
  })
})
