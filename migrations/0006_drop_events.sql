-- The event log moves into the PR Durable Object's own SQLite (PrCoordinator).
-- D1 is no longer an event sink — it holds only settled projections. The box's
-- events land in the object's `log` table, fan out live from there, and flush
-- to a per-run R2 `.jsonl` archive at end of run. See architecture.md,
-- "The log and its projections".
DROP TABLE IF EXISTS events;
