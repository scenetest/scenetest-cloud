import { describe, it, expect } from 'vitest'
import { SchemaValidationError } from '@tanstack/db'
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

describe('ws-shape scenes collection', () => {
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

  // The crux: synced data is NOT schema-validated, but client mutations ARE.
  it('SYNC path accepts a row outside the schema enum (raw replica)', async () => {
    const { source, emit } = fakeSource()
    const scenes = createScenesCollection(source)
    await scenes.preload()

    // 'flaky' is not in the SceneRow status enum.
    emit(start('e2e', 'flaky.scene.ts'))
    emit(end('e2e', 'flaky', 50))

    const row = scenes.get('flaky.scene.ts:e2e')
    // It landed anyway — sync writes bypass schema validation entirely.
    expect(row?.status).toBe('flaky')
  })

  it('CLIENT mutation path DOES validate the same bad row', async () => {
    const { source } = fakeSource()
    const scenes = createScenesCollection(source)
    await scenes.preload()

    const bad = {
      scene_id: 'x', file: 'x', name: 'x',
      status: 'flaky', teamIndex: 0, startedAt: 1,
    } as unknown as SceneRow

    // Same shape that sailed through sync throws when offered as a client write.
    expect(() => scenes.validateData(bad, 'insert')).toThrow(SchemaValidationError)
  })
})
