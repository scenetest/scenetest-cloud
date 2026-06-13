import { useMemo } from 'preact/hooks'
import { useLiveQuery } from '@tanstack/react-db'
import { count, eq } from '@tanstack/db'
import { runShapeSource } from '../lib/runShapeSource.ts'
import { createScenesCollection, type SceneRow } from '../lib/collections/scenes.ts'

// Cloud-owned chrome (docs aesthetic), deliberately NOT the terminal widget.
// POC NOTE: this read model belongs INSIDE the @scenetest/dashboard widget
// (one consumer of the event stream, shared dev+cloud, fed by transport.subscribe).
// It lives here only because the widget is a separate package this repo can't
// reach into — see the chat. The collection + queries below migrate unchanged.
//
// Three live queries, each maintained incrementally by d2ts as rows land:
//   1. status rollup  — groupBy + count  (aggregate IVM)
//   2. failing now     — where            (filtered view)
//   3. timeline        — orderBy          (sorted view)

const STATUS: Record<string, string> = {
  running: '#d29922',
  passed: '#3fb950',
  failed: '#f85149',
  skipped: '#8b949e',
}

export function ScenesPanel({ runId }: { runId: string }) {
  // One collection per run, fed by the shared per-run WS source. useMemo so a
  // re-render doesn't spin up a second collection (and a second socket).
  const collection = useMemo(
    () => createScenesCollection(runShapeSource(runId)),
    [runId],
  )

  // 1. Aggregate rollup: counts per status. groupBy + count(), recomputed on
  //    the delta only — the reason d2ts is in the bundle.
  const { data: rollup } = useLiveQuery(
    (q) =>
      q
        .from({ s: collection })
        .groupBy(({ s }) => s.status)
        .select(({ s }) => ({ status: s.status, n: count(s.scene_id) })),
    [collection],
  )

  // 2. Filtered live view: only scenes currently failing.
  const { data: failing } = useLiveQuery(
    (q) => q.from({ s: collection }).where(({ s }) => eq(s.status, 'failed')),
    [collection],
  )

  // 3. Sorted timeline: the whole run in start order.
  const { data: timeline, status } = useLiveQuery(
    (q) => q.from({ s: collection }).orderBy(({ s }) => s.startedAt, 'asc'),
    [collection],
  )

  const counts = (rollup ?? []) as Array<{ status: string; n: number }>
  const failed = (failing ?? []) as SceneRow[]
  const scenes = (timeline ?? []) as SceneRow[]
  const total = counts.reduce((a, c) => a + c.n, 0)

  return (
    <section style="margin-top:1.5rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
      <div style="display:flex;align-items:baseline;gap:.75rem;margin-bottom:.5rem">
        <strong style="font-size:.95rem">scenes</strong>
        <span style="font-size:.75rem;color:#8b949e">live via WS · {status} · {total} total</span>
      </div>

      {/* 1. rollup chips — a live groupBy/count aggregate */}
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.75rem">
        {counts.length === 0 ? (
          <span style="color:#8b949e;font-size:.8rem">waiting for scene events…</span>
        ) : (
          counts
            .slice()
            .sort((a, b) => a.status.localeCompare(b.status))
            .map((c) => (
              <span
                key={c.status}
                style={`font-size:.75rem;border:1px solid #e5e7eb;border-radius:999px;padding:.1rem .6rem;color:${STATUS[c.status] ?? '#8b949e'}`}
              >
                {c.status} · {c.n}
              </span>
            ))
        )}
      </div>

      {/* 2. filtered view — only renders when something is failing */}
      {failed.length > 0 && (
        <div style="font-size:.78rem;color:#f85149;margin-bottom:.6rem">
          ⚠ failing: {failed.map((f) => f.name).join(', ')}
        </div>
      )}

      {/* 3. sorted timeline */}
      {scenes.length > 0 && (
        <table style="width:100%;border-collapse:collapse;font-size:.8rem">
          <tbody>
            {scenes.map((s) => (
              <tr key={s.scene_id} style="border-top:1px solid #e5e7eb">
                <td style="padding:.35rem .5rem;white-space:nowrap">
                  <span
                    style={`display:inline-block;width:.6rem;height:.6rem;border-radius:50%;margin-right:.5rem;background:${STATUS[s.status] ?? '#8b949e'}`}
                  />
                  {s.name}
                </td>
                <td style="padding:.35rem .5rem;color:#8b949e">{s.file}</td>
                <td style="padding:.35rem .5rem;color:#8b949e">{s.status}</td>
                <td style="padding:.35rem .5rem;color:#8b949e;text-align:right">
                  {s.durationMs == null ? '—' : `${s.durationMs}ms`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
