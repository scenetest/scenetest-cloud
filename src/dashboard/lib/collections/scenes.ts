import { createCollection } from '@tanstack/db'
import type { RunEvent } from '@scenetest/protocol'
import { wsShapeSync, type ShapeChange } from '../wsShapeCollection.ts'
import type { ShapeSource } from '../runShapeSource.ts'

// One row per scene execution, folded from the protocol event stream. scene_id
// mirrors the server's convention ('<file>:<scene name>').
//
// Read-only replica: there is NO client mutation path. The collection has no
// onInsert/onUpdate/onDelete handlers, so the ONLY writer is the sync reducer
// below — server → client, one direction. `status` is a plain string because
// we mirror whatever the producer emits (no enum to validate against; nothing
// here validates synced data, by design).
export interface SceneRow {
  scene_id: string
  file: string
  name: string
  status: string // 'running' | 'passed' | 'failed' | 'skipped' | … (producer-defined)
  teamIndex: number
  startedAt: number
  endedAt?: number
  durationMs?: number
  error?: string
}

// scene:start opens a row; scene:end closes it. scene:end carries `name` but
// not `file`, so we resolve back to the running row by name (POC limitation:
// same scene name in two files would collide — a real build either keys by a
// producer-supplied id or has the producer include `file` on scene:end).
export function projectScene(
  event: RunEvent,
  rows: Map<string, SceneRow>,
): Array<ShapeChange<SceneRow>> {
  if (event.type === 'scene:start') {
    const scene_id = `${event.file}:${event.name}`
    const row: SceneRow = {
      scene_id,
      file: event.file,
      name: event.name,
      status: 'running',
      teamIndex: event.teamIndex,
      startedAt: event.timestamp,
    }
    rows.set(scene_id, row)
    return [{ type: 'insert', value: row }]
  }

  if (event.type === 'scene:end') {
    const open = [...rows.values()].find(
      (r) => r.name === event.name && r.status === 'running',
    )
    if (!open) return []
    const row: SceneRow = {
      ...open,
      status: event.status,
      endedAt: event.timestamp,
      durationMs: event.duration,
      ...(event.error === undefined ? {} : { error: event.error }),
    }
    rows.set(row.scene_id, row)
    return [{ type: 'update', value: row }]
  }

  return []
}

// The concrete read-only collection: attach it to a run's shared WS source.
// No mutation handlers are configured — the sync reducer is the sole writer.
export function createScenesCollection(source: ShapeSource) {
  return createCollection<SceneRow, string>({
    id: 'scenes',
    getKey: (row) => row.scene_id,
    sync: wsShapeSync<SceneRow>({ source, project: projectScene }),
  })
}
