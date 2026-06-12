-- R2 durable event-log artifacts (issue #23).
--
-- At the end of a run its events are assembled into a single .jsonl object in
-- the ARTIFACTS R2 bucket; this column records that object's key. Once it is
-- set (and the run is older than EVENTS_RETENTION_HOURS), the cron sweep
-- prunes the run's rows from the `events` table — D1 holds metadata, R2 holds
-- the durable log, as architecture.md requires. NULL means the artifact has
-- not been written yet (run still in flight, or the sweep has not reached it).
ALTER TABLE runs ADD COLUMN artifact_key TEXT;
