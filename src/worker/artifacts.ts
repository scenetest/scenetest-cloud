import type { Env } from './env.ts'

// R2 durable event-log artifacts (issue #23).
//
// At end of run the worker assembles the run's events — which all already
// transit D1 — into a single .jsonl object in the ARTIFACTS bucket, and
// records its key on `runs.artifact_key`. The cron sweep is the guarantee:
// terminal runs missing a key get one, then the `events` rows of artifacted
// runs older than EVENTS_RETENTION_HOURS are pruned. D1 keeps metadata; R2
// keeps the durable log (architecture.md, "Cloud service" → R2 bullet).
//
// Artifact line format: one event per line, `{"seq":N,"payload":<payload>}`.
// seq is preserved so the viewer replay can serve byte-equivalent frames from
// the artifact once D1's rows are gone — payload is the raw event JSON the box
// emitted (the same bytes stored in the `events.payload` column).
//
// The box uploading directly (presigned URL) could replace worker-side
// assembly if event volume ever outgrows D1 transit; until then assembling
// from D1 keeps a single ingest path and one source of truth.

const PAGE = 1000
const DEFAULT_RETENTION_HOURS = 24

export function artifactKey(repo: string, runId: string): string {
  return `runs/${repo}/${runId}.jsonl`
}

// Build the .jsonl body for a run from its D1 events, paging to avoid loading
// a long run into memory at once. Does not touch R2 or `artifact_key`; callers
// that want to persist use assembleArtifact, and the log endpoint uses this
// directly to serve a run whose artifact has not been written yet.
export async function buildJsonl(env: Env, runId: string): Promise<string> {
  const lines: string[] = []
  let after = 0
  for (;;) {
    const { results } = await env.DB.prepare(
      'SELECT seq, payload FROM events WHERE run_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3',
    )
      .bind(runId, after, PAGE)
      .all<{ seq: number; payload: string }>()
    const rows = results ?? []
    for (const row of rows) {
      // row.payload is already a JSON string; embed it raw so we never reparse.
      lines.push(`{"seq":${row.seq},"payload":${row.payload}}`)
      after = row.seq
    }
    if (rows.length < PAGE) break
  }
  return lines.length ? lines.join('\n') + '\n' : ''
}

// Assemble a run's events into its R2 artifact and record the key. Idempotent:
// a run that already has a key is left alone (returns the existing key).
// Best-effort — callers fire it through waitUntil at completion; the cron
// sweep covers anything that slips through. No-op without the ARTIFACTS
// binding.
export async function assembleArtifact(env: Env, runId: string): Promise<string | null> {
  if (!env.ARTIFACTS) return null
  const run = await env.DB.prepare('SELECT repo, artifact_key FROM runs WHERE id = ?1')
    .bind(runId)
    .first<{ repo: string; artifact_key: string | null }>()
  if (!run) return null
  if (run.artifact_key) return run.artifact_key

  const body = await buildJsonl(env, runId)
  const key = artifactKey(run.repo, runId)
  await env.ARTIFACTS.put(key, body, {
    httpMetadata: { contentType: 'application/x-ndjson' },
  })
  await env.DB.prepare('UPDATE runs SET artifact_key = ?1 WHERE id = ?2').bind(key, runId).run()
  return key
}

export async function getArtifactKey(env: Env, runId: string): Promise<string | null> {
  const run = await env.DB.prepare('SELECT artifact_key FROM runs WHERE id = ?1')
    .bind(runId)
    .first<{ artifact_key: string | null }>()
  return run?.artifact_key ?? null
}

// Read an artifact back as replay frames: events with seq > sinceSeq, each
// payload re-stringified so the bytes match what the D1 replay path sends.
// Used by the viewer WS/SSE fallback once a run's D1 rows have been pruned.
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

// The cron sweep — runs regardless of RUNNER_PROVIDER (see runner/tick.ts).
// Two passes: (1) write artifacts for terminal runs still missing one
// (completions assemble best-effort at the time; cancellations — which skip
// that — and any dropped waitUntil land here), then (2) prune `events` rows
// for artifacted runs whose end is older than the retention window. The EXISTS
// clause keeps already-pruned runs out of the delete set. No-op without the
// ARTIFACTS binding.
export async function sweepArtifacts(env: Env): Promise<void> {
  if (!env.ARTIFACTS) return

  const pending = await env.DB.prepare(
    `SELECT id FROM runs
       WHERE artifact_key IS NULL AND status IN ('passed', 'failed', 'cancelled')
       LIMIT 100`,
  ).all<{ id: string }>()
  for (const row of pending.results ?? []) {
    try {
      await assembleArtifact(env, row.id)
    } catch (err) {
      console.error(`sweep: assembling ${row.id} failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  const hours = parseInt(env.EVENTS_RETENTION_HOURS ?? '', 10)
  const retentionHours = Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_RETENTION_HOURS
  const cutoff = Date.now() - retentionHours * 3_600_000
  const prunable = await env.DB.prepare(
    `SELECT id FROM runs
       WHERE artifact_key IS NOT NULL AND ended_at IS NOT NULL AND ended_at < ?1
         AND EXISTS (SELECT 1 FROM events WHERE events.run_id = runs.id)
       LIMIT 100`,
  )
    .bind(cutoff)
    .all<{ id: string }>()
  const ids = (prunable.results ?? []).map((row) => row.id)
  if (ids.length > 0) {
    // One batched round trip rather than a DELETE per run (cf. insertEvents).
    const del = env.DB.prepare('DELETE FROM events WHERE run_id = ?1')
    await env.DB.batch(ids.map((id) => del.bind(id)))
  }
}
