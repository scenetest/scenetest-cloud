import type { Env } from './env.ts'

// R2 durable event-log artifacts. The read half plus the shared key format;
// the PR object writes them (PrCoordinator.archiveRun).
//
// THE DO OWNS THE LOG: the box asserts a fact `(seq, payload)` and the PR object
// records it under a PR-global `id` in receive-order. So R2 must recreate the
// log exactly — an archive line is the whole log row, not just the fact:
//
//   {"id":N,"seq":M,"ts":T,"payload":<payload>}
//
// On revival a run is folded back under its original `id` (rehydrateArchived),
// so the stream replays the same whatever order runs are restored in. The /log
// download projects this back to the box's {seq,payload} view (getRunLog), so it
// reads the same live or from R2 — recognizably the box's file, no byte-parity
// claim. D1 never holds log lines (architecture.md, "The log and its projections").

export function artifactKey(repo: string, runId: string): string {
  return `runs/${repo}/${runId}.jsonl`
}

export async function getArtifactKey(env: Env, runId: string): Promise<string | null> {
  const run = await env.DB.prepare('SELECT artifact_key FROM runs WHERE id = ?1')
    .bind(runId)
    .first<{ artifact_key: string | null }>()
  return run?.artifact_key ?? null
}

// A log row as it round-trips through R2. `id`/`ts` are the log's own metadata
// (nullable: pre-id archives omit them). payload is re-stringified so callers
// embed it without reparsing.
export interface ArchivedRow {
  id: number | null
  seq: number
  ts: number | null
  payload: string
}

// Full log rows — the PR object reads these to rehydrate a run under its ids.
export async function readArtifactLog(env: Env, key: string): Promise<ArchivedRow[]> {
  if (!env.ARTIFACTS) return []
  const obj = await env.ARTIFACTS.get(key)
  if (!obj) return []
  const text = await obj.text()
  const out: ArchivedRow[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    let evt: { id?: unknown; seq?: unknown; ts?: unknown; payload?: unknown }
    try {
      evt = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof evt.seq !== 'number') continue
    out.push({
      id: typeof evt.id === 'number' ? evt.id : null,
      seq: evt.seq,
      ts: typeof evt.ts === 'number' ? evt.ts : null,
      payload: JSON.stringify(evt.payload ?? null),
    })
  }
  return out
}

// Per-run replay frames (seq > sinceSeq) for the per-run viewer's R2 fallback,
// once a run's log is no longer in its object.
export async function readArtifactEvents(
  env: Env,
  key: string,
  sinceSeq: number,
): Promise<Array<{ seq: number; payload: string }>> {
  const rows = await readArtifactLog(env, key)
  return rows
    .filter((r) => r.seq > sinceSeq)
    .map((r) => ({ seq: r.seq, payload: r.payload }))
}

// The archive projected to the box's {seq,payload} .jsonl — the /log download
// view, same as live /jsonl. Null when absent/empty so the caller falls back.
export async function readArtifactBoxJsonl(env: Env, key: string): Promise<string | null> {
  const rows = await readArtifactLog(env, key)
  if (rows.length === 0) return null
  return rows.map((r) => `{"seq":${r.seq},"payload":${r.payload}}`).join('\n') + '\n'
}
