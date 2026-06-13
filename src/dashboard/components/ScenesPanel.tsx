import { useMemo } from 'preact/hooks'
import { useLiveQuery } from '@tanstack/react-db'
import { runShapeSource } from '../lib/runShapeSource.ts'
import { createScenesCollection, type SceneRow } from '../lib/collections/scenes.ts'

// Cloud-owned chrome (docs aesthetic), deliberately NOT the terminal widget —
// this panel proves the WS → TanStack DB → reactive-hook path in the real page.
// It mounts beside the @scenetest/dashboard widget and reads the SAME run WS
// through runShapeSource, folding events into the scenes collection and
// rendering them via useLiveQuery. Nothing here pushes writes; it's read-only.

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

  // The reactive read: this recomputes incrementally as scene rows land.
  const { data, status } = useLiveQuery((q) => q.from({ s: collection }))
  const scenes = (data ?? []) as SceneRow[]

  const by = (s: string) => scenes.filter((r) => r.status === s).length

  return (
    <section style="margin-top:1.5rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
      <div style="display:flex;align-items:baseline;gap:.75rem;margin-bottom:.5rem">
        <strong style="font-size:.95rem">scenes</strong>
        <span style="font-size:.75rem;color:#8b949e">
          live via WS · {status} · {scenes.length} scene{scenes.length === 1 ? '' : 's'}
          {' · '}
          {by('running')} running · {by('passed')} passed · {by('failed')} failed
        </span>
      </div>

      {scenes.length === 0 ? (
        <div style="color:#8b949e;font-size:.8rem">waiting for scene events…</div>
      ) : (
        <table style="width:100%;border-collapse:collapse;font-size:.8rem">
          <tbody>
            {scenes
              .slice()
              .sort((a, b) => a.startedAt - b.startedAt)
              .map((s) => (
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
