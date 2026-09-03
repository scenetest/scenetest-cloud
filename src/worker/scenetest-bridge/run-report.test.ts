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
    const report = buildRunReport(stampedRun())

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

  it('rolls up the summary from the run’s own counts', () => {
    expect(buildRunReport(stampedRun()).summary).toEqual({
      scenes: 2, completed: 1, failed: 1,
      assertions: { total: 2, passed: 1, failed: 1 }, warnings: 0,
    })
  })

  it('pairs an action:start with its action:end once, not twice', () => {
    expect(buildRunReport(stampedRun()).scenes[0]!.timeline).toHaveLength(1)
  })

  it('carries an action error through to the timeline', () => {
    const events = stampedRun()
    Object.assign(events.find((e) => e.type === 'action:end')!, { error: 'element not found' })
    expect(buildRunReport(events).scenes[0]!.timeline[0]!.error).toBe('element not found')
  })

  it('marks an unfinished action in flight, with no duration', () => {
    const events = stampedRun().filter((e) => e.type !== 'action:end')
    expect(buildRunReport(events).scenes[0]!.timeline).toEqual([
      { actor: 'Alice', action: 'click (in flight)', target: 'button:Submit', duration: null, error: null },
    ])
  })

  it('counts what it saw when the run has no run:end', () => {
    const events = stampedRun().filter((e) => e.type !== 'run:end')
    // sceneCount comes from run:start; the rest is counted from the scenes.
    expect(buildRunReport(events).summary).toEqual({
      scenes: 2, completed: 1, failed: 1,
      assertions: { total: 2, passed: 1, failed: 1 }, warnings: 0,
    })
  })

  it('counts warnings, which the run summary does not carry', () => {
    const events = stampedRun()
    events.push({
      type: 'warning', timestamp: 156, runId: RUN, actor: 'Buyer',
      selector: '#total', message: 'selector matched twice',
    })
    expect(buildRunReport(events).summary.warnings).toBe(1)
  })

  // Older producers stamp no owning scene. Those rows attribute by actor and
  // time window instead — the same rule the widget's live fold applies.
  it('attributes unstamped rows by actor and time window', () => {
    const events = stampedRun().map((e) => {
      const { scene: _scene, ...rest } = e as RunEvent & { scene?: string }
      return rest as RunEvent
    })
    const report = buildRunReport(events)
    expect(report.scenes[0]!.assertions.map((a) => a.description)).toEqual(['greeting shows'])
    expect(report.scenes[1]!.assertions.map((a) => a.description)).toEqual(['total is $42'])
    expect(report.scenes[0]!.timeline).toHaveLength(1)
  })

  it('drops a row that attributes to no scene, but still counts it', () => {
    const events = stampedRun()
    events.push({
      type: 'assertion', timestamp: 9999, runId: RUN,
      description: 'no actor, no scene, long after the run', result: true,
    })
    const report = buildRunReport(events)
    expect(report.scenes.flatMap((s) => s.assertions)).toHaveLength(2)
    // The live view counts every assertion of the run, attributed or not.
    expect(report.summary.assertions.total).toBe(3)
  })

  // A run recorded by a producer that omitted a field the fold reads costs that
  // one event, not the whole report.
  it('skips an event it cannot fold and keeps the rest', () => {
    const events = stampedRun()
    events.splice(1, 0, { type: 'scene:start', timestamp: 105, runId: RUN, name: 'legacy' } as unknown as RunEvent)
    const report = buildRunReport(events)
    expect(report.scenes.map((s) => s.name)).toEqual(['logs in', 'checks out'])
  })

  it('returns an empty report for a run with no events', () => {
    expect(buildRunReport([])).toEqual({
      scenes: [],
      summary: {
        scenes: 0, completed: 0, failed: 0,
        assertions: { total: 0, passed: 0, failed: 0 }, warnings: 0,
      },
    })
  })
})
