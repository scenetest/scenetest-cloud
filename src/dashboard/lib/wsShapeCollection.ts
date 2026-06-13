import type { SyncConfig } from '@tanstack/db'
import type { RunEvent } from '@scenetest/protocol'
import type { ShapeSource } from './runShapeSource.ts'

// A change op a reducer emits. insert/update carry the full row (we run in
// rowUpdateMode 'full', so the row replaces rather than merges); delete carries
// just the key.
export type ShapeChange<T> =
  | { type: 'insert' | 'update'; value: T }
  | { type: 'delete'; key: string }

// project: a stateful fold. Given a protocol event and the reducer's current
// view of rows, mutate `rows` and return the write ops (or [] to ignore the
// event). The reducer owns `rows`; the collection mirrors it.
export interface WsShapeSyncOptions<T extends object> {
  source: ShapeSource
  project: (event: RunEvent, rows: Map<string, T>) => Array<ShapeChange<T>>
  // Optionally validate/transform rows on the SYNC path. Default: off — synced
  // rows land raw (the collection schema, if any, then only gates client
  // mutations, leaving validation as a read-time/explicit concern). Pass a
  // parser here to make sync validation eager instead. This flag *is* the
  // validate-on-read vs validate-on-write switch.
  validateOnSync?: (row: T) => T
}

// Build a TanStack DB SyncConfig that feeds a collection from a run's WS shape.
// This is the reusable "collection type that attaches to our WS" — point it at
// runShapeSource(runId) and give it a reducer.
export function wsShapeSync<T extends object>(
  opts: WsShapeSyncOptions<T>,
): SyncConfig<T, string> {
  return {
    rowUpdateMode: 'full',
    sync: ({ begin, write, commit, markReady }) => {
      const rows = new Map<string, T>()
      const off = opts.source.subscribe(
        (event) => {
          const ops = opts.project(event, rows)
          if (ops.length === 0) return
          begin()
          for (const op of ops) {
            if (op.type === 'delete') {
              write({ type: 'delete', key: op.key })
            } else {
              const value = opts.validateOnSync ? opts.validateOnSync(op.value) : op.value
              write({ type: op.type, value })
            }
          }
          commit()
        },
        () => markReady(),
      )
      return off
    },
  }
}
