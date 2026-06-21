-- Reports-as-stages (#25). The overview_* tables have existed since 0001 but
-- nothing wrote them, and they were keyed by run_id. A static-analysis report
-- (lint/typecheck deltas, bundle sizes) is a *stage output*, content-addressed
-- exactly like the build artifact it ships beside: keyed by the stage's input
-- hash, not the run. That keying is the whole point —
--   * identical inputs share one report across runs AND across PRs;
--   * a skipped (cache-hit) stage's report already exists for that hash, so
--     dedupe falls out for free;
--   * the PR comparison view is "report at base hash vs report at head hash".
-- See architecture.md, "The build pipeline" → static-analysis reports.
--
-- Nothing read or wrote the old tables, so this drops and recreates rather than
-- migrating data.

DROP TABLE IF EXISTS overview_issue_diffs;
DROP TABLE IF EXISTS overview_summaries;
DROP TABLE IF EXISTS overview_metrics;

-- A single scalar measurement at a stage's input hash: bundle.raw, bundle.gzip,
-- a typecheck error count, … The base-vs-head delta is computed at read time by
-- pairing two hashes' rows, so a metric here is one value, never a base/pr pair.
CREATE TABLE overview_metrics (
  stage      TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  name       TEXT NOT NULL,   -- 'bundle.raw' | 'bundle.gzip' | 'typecheck.errors' | ...
  value      REAL NOT NULL,
  unit       TEXT,            -- 'bytes' | 'count' | ... (display hint)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (stage, input_hash, name)
);

-- A free-form summary blob per analysis kind at a hash (totals, config echo).
CREATE TABLE overview_summaries (
  stage        TEXT NOT NULL,
  input_hash   TEXT NOT NULL,
  kind         TEXT NOT NULL, -- 'typecheck' | 'lint' | ...
  summary_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (stage, input_hash, kind)
);

-- The raw issue list at a hash. The new/resolved diff is computed at read time
-- between the base and head issue sets — not stored — so a report is one set,
-- shareable by hash. `fingerprint` is a stable per-issue id (file+pos+message)
-- that both dedupes re-emission and anchors the cross-hash diff.
CREATE TABLE overview_issues (
  stage       TEXT NOT NULL,
  input_hash  TEXT NOT NULL,
  kind        TEXT NOT NULL, -- 'typecheck' | 'lint'
  fingerprint TEXT NOT NULL,
  file        TEXT,
  line        INTEGER,
  col         INTEGER,
  severity    TEXT,          -- 'error' | 'warning' | ...
  message     TEXT,
  raw         TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (stage, input_hash, fingerprint)
);
CREATE INDEX overview_issues_hash_idx ON overview_issues(stage, input_hash);

-- The desired report vectors (report name → input_hash) for this run's head and
-- base shas, computed at run creation by computeStagePlan. The head vector names
-- the hashes the box tags its reports with; the base vector resolves the "report
-- at base hash" side of the comparison without re-hitting GitHub on every page
-- load. NULL/empty on the coarse-fallback path or when base is unknown. (Named
-- *_vector_json rather than *_reports_json so the column survives if the keyed
-- thing is ever generalized.)
ALTER TABLE runs ADD COLUMN head_vector_json TEXT;
ALTER TABLE runs ADD COLUMN base_vector_json TEXT;
