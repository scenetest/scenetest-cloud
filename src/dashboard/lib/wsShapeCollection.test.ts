import { describe, it, expect } from 'vitest'
import { MissingInsertHandlerError, createLiveQueryCollection, count } from '@tanstack/db'
import type { RunEvent, TeamMeta } from '@scenetest/protocol'
import type { ShapeSource } from './runShapeSource.ts'
import { createScenesCollection, type SceneRow } from './collections/scenes.ts'

// A synchronous in-memory ShapeSource: emit() pushes a protocol event to every
// attached collection, exactly as the WS fan-out would.
function fakeSource(): { source: ShapeSource; emit: (event: RunEvent) => void } {
  const listeners = new Set<(event: RunEvent) => void>()
  return {
    source: {
      subscribe(onEvent, onReady) {
        listeners.add(onEvent)
        onReady?.()
        return () => listeners.delete(onEvent)
      },
    },
    emit(event) {
      for (const l of listeners) l(event)
    },
  }
}

const team: TeamMeta = { name: 'default' }
const start = (name: string, file: string): RunEvent => ({
  type: 'scene:start', timestamp: 1000, name, file, actors: ['a'], teamIndex: 0, team,
})
const end = (name: string, status: string, duration: number): RunEvent => ({
  type: 'scene:end', timestamp: 2000, name, status, duration, teamIndex: 0, team,
})

describe('ws-shape scenes collection (read-only replica)', () => {
  it('folds scene:start → scene:end into a row (insert then update)', async () => {
    const { source, emit } = fakeSource()
    const scenes = createScenesCollection(source)
    await scenes.preload()

    emit(start('login', 'auth.scene.ts'))
    expect(scenes.get('auth.scene.ts:login')?.status).toBe('running')

    emit(end('login', 'passed', 1200))
    const row = scenes.get('auth.scene.ts:login')
    expect(row?.status).toBe('passed')
    expect(row?.durationMs).toBe(1200)
    expect(row?.endedAt).toBe(2000)
    expect(scenes.size).toBe(1)
  })

  it('reactive query: a derived view recomputes as events arrive', async () => {
    const { source, emit } = fakeSource()
    const scenes = createScenesCollection(source)
    await scenes.preload()

    const failing = () => scenes.toArray.filter((r) => r.status === 'failed').length
    emit(start('a', 'f.ts')); emit(start('b', 'f.ts'))
    expect(failing()).toBe(0)
    emit(end('a', 'failed', 10))
    expect(failing()).toBe(1)
  })

  it('mirrors whatever the producer emits — no validation on the sync path', async () => {
    const { source, emit } = fakeSource()
    const scenes = createScenesCollection(source)
    await scenes.preload()

    // An arbitrary producer-defined status lands as-is: a read replica mirrors
    // the source, it does not police it.
    emit(start('e2e', 'flaky.scene.ts'))
    emit(end('e2e', 'flaky', 50))
    expect(scenes.get('flaky.scene.ts:e2e')?.status).toBe('flaky')
  })

  it('live aggregate (groupBy status → count) recomputes incrementally', async () => {
    const { source, emit } = fakeSource()
    const scenes = createScenesCollection(source)
    await scenes.preload()

    // The same query the panel runs — maintained by d2ts, headless here.
    const rollup = createLiveQueryCollection({
      query: (q) =>
        q
          .from({ s: scenes })
          .groupBy(({ s }) => s.status)
          .select(({ s }) => ({ status: s.status, n: count(s.scene_id) })),
    })
    await rollup.preload()
    const n = (status: string) =>
      (rollup.toArray as Array<{ status: string; n: number }>).find((r) => r.status === status)?.n ?? 0

    emit(start('a', 'f.ts'))
    emit(start('b', 'f.ts'))
    expect(n('running')).toBe(2)

    emit(end('a', 'passed', 10))
    expect(n('running')).toBe(1)
    expect(n('passed')).toBe(1)
  })

  it('is structurally read-only: there is no client mutation path', async () => {
    const { source } = fakeSource()
    const scenes = createScenesCollection(source)
    await scenes.preload()

    const row: SceneRow = {
      scene_id: 'x', file: 'x', name: 'x', status: 'running', teamIndex: 0, startedAt: 1,
    }
    // No onInsert/onUpdate/onDelete handler is configured, so a client write
    // throws rather than mutating — the sync reducer is the only writer.
    expect(() => scenes.insert(row)).toThrow(MissingInsertHandlerError)
  })
})
