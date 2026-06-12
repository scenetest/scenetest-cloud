-- Main-branch metric timeline. A linear metric (bundle size, etc.) sampled at
-- each merge to a base branch, so the dashboard can chart it over commits/time
-- — the "report at every merge" series the overview tables can't express on
-- their own (those are keyed per run, i.e. per PR).
--
-- One row per (repo, base_ref, metric, merge commit). Metadata only — a handful
-- of bytes per merge — so it stays in D1 by the same rule as everything else.
-- The point's value is the merged PR's measured metric: a merge to main reuses
-- the merged PR's artifacts, so the PR's head reading IS the main-line reading.
CREATE TABLE metric_history (
  repo TEXT NOT NULL,
  base_ref TEXT NOT NULL,       -- branch the point landed on ('main')
  name TEXT NOT NULL,           -- 'bundle.raw' | 'bundle.gzip' | ...
  commit_sha TEXT NOT NULL,     -- merge commit on the base branch
  value REAL NOT NULL,
  pr_number INTEGER,            -- PR that produced the point (NULL = backfill)
  recorded_at INTEGER NOT NULL, -- merge time; the timeline's x-axis
  PRIMARY KEY (repo, base_ref, name, commit_sha)
);
CREATE INDEX metric_history_series_idx
  ON metric_history(repo, base_ref, name, recorded_at);
