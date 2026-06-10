// Shared statements where two writers must stay wire-compatible (e.g. the
// HTTP ingest route and the dev stub runner both feed the events table that
// the SSE bridge reads back).

export interface RunEvent {
  seq: number
  payload: unknown
}

export async function insertEvents(
  db: D1Database,
  runId: string,
  events: RunEvent[],
): Promise<void> {
  const now = Date.now()
  const stmt = db.prepare(
    'INSERT INTO events (run_id, seq, payload, ts) VALUES (?1, ?2, ?3, ?4)',
  )
  await db.batch(
    events.map((e) => stmt.bind(runId, e.seq, JSON.stringify(e.payload ?? null), now)),
  )
}
