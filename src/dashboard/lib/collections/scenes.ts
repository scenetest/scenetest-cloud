import { z } from 'zod'
import { createCollection } from '@tanstack/db'
import type { RunEvent } from '@scenetest/protocol'
import { wsShapeSync, type ShapeChange } from '../wsShapeCollection.ts'
import type { ShapeSource } from '../runShapeSource.ts'

// One row per scene execution, folded from the protocol event stream. scene_id
// mirrors the server's convention ('<file>:<scene name>'). status is a closed
// enum here on purpose — see the test: a scene:end whose status is outside this
// set still lands via the SYNC path (raw replica), because the schema gates
// only client mutations, not synced writes.
export const SceneRow = z.object({
  scene_id: z.string(),
  file: z.string(),
  name: z.string(),
  status: z.enum(['running', 'passed', 'failed', 'skipped']),
  teamIndex: z.number().int(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
})
export type SceneRow = z.infer<typeof SceneRow>

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
      // cast: protocol scene:end.status is an open string; on the raw sync
      // path we store it as-is even if it falls outside the enum.
      status: event.status as SceneRow['status'],
      endedAt: event.timestamp,
      durationMs: event.duration,
      ...(event.error === undefined ? {} : { error: event.error }),
    }
    rows.set(row.scene_id, row)
    return [{ type: 'update', value: row }]
  }

  return []
}

// The concrete collection: attach it to a run's shared WS source.
export function createScenesCollection(source: ShapeSource) {
  return createCollection({
    id: 'scenes',
    schema: SceneRow,
    getKey: (row: SceneRow) => row.scene_id,
    sync: wsShapeSync<SceneRow>({ source, project: projectScene }),
  })
}
