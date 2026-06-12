// Shared DB helpers. insertEvents is the single write path for the events
// table; all ingest routes go through the DO's ingestAndFanout which calls it.

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
