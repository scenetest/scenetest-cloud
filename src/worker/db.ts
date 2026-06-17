// Shared types for the event ingest path. The log itself lives in the PR
// Durable Object's SQLite (PrCoordinator), not in D1 — D1 holds only settled
// projections (architecture.md, "The log and its projections").

export interface RunEvent {
  seq: number
  payload: unknown
}
