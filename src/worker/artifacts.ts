import type { Env } from './env.ts'

// R2 durable event-log artifacts.
//
// The PR Durable Object owns the live log in its own SQLite and flushes a run
// to R2 at end of run (PrCoordinator.archiveRun) — the assembly lives there,
// next to the data. This module is the read half plus the shared key format:
// the worker reads an archived run's `.jsonl` back as replay frames once the
// live object no longer has it. D1 never holds log lines (architecture.md,
// "The log and its projections").
//
// Artifact line format: one event per line, `{"seq":N,"payload":<payload>}`.
// seq is preserved so the viewer replay serves byte-equivalent frames from the
// archive — payload is the raw event JSON the box emitted.

export function artifactKey(repo: string, runId: string): string {
  return `runs/${repo}/${runId}.jsonl`
}

export async function getArtifactKey(env: Env, runId: string): Promise<string | null> {
  const run = await env.DB.prepare('SELECT artifact_key FROM runs WHERE id = ?1')
    .bind(runId)
    .first<{ artifact_key: string | null }>()
  return run?.artifact_key ?? null
}

// Read an artifact back as replay frames: events with seq > sinceSeq, each
// payload re-stringified so the bytes match what the live replay path sends.
// Used by the viewer WS/SSE fallback once a run's log is no longer in its
// object (its PR closed and the object was reset after archiving).
export async function readArtifactEvents(
  env: Env,
  key: string,
  sinceSeq: number,
): Promise<Array<{ seq: number; payload: string }>> {
  if (!env.ARTIFACTS) return []
  const obj = await env.ARTIFACTS.get(key)
  if (!obj) return []
  const text = await obj.text()
  const out: Array<{ seq: number; payload: string }> = []
  for (const line of text.split('\n')) {
    if (!line) continue
    let evt: { seq?: unknown; payload?: unknown }
    try {
      evt = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof evt.seq !== 'number' || evt.seq <= sinceSeq) continue
    out.push({ seq: evt.seq, payload: JSON.stringify(evt.payload ?? null) })
  }
  return out
}
