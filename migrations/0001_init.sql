-- Two-level scene model. A `run` is a batch (one ephemeral VM execution).
-- A `scene_execution` is the atomic unit. The "current state of this PR" view
-- is most-recent scene_execution per scene_id, NOT the latest run.
--
-- `events.payload` is opaque JSON owned by scenetest-js's wire format. The worker
-- stores and forwards it down SSE without parsing; scenetest-js's dashboard
-- consumes it directly.

CREATE TABLE prs (
  pr_number INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  next_push_filter TEXT, -- JSON array of scene_ids, or NULL = run all
  opened_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  pr_number INTEGER NOT NULL REFERENCES prs(pr_number) ON DELETE CASCADE,
  head_sha TEXT NOT NULL,
  base_sha TEXT,
  trigger TEXT NOT NULL, -- 'push' | 'manual' | 'auto-filter'
  subset_json TEXT,      -- JSON array of scene_ids, NULL = all
  status TEXT NOT NULL,  -- 'queued' | 'running' | 'passed' | 'failed' | 'cancelled'
  image_version TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  runner_id TEXT,
  bearer_token_hash TEXT NOT NULL,
  triggered_by_user_id TEXT
);
CREATE INDEX runs_pr_started_idx ON runs(pr_number, started_at DESC);

CREATE TABLE scene_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  scene_id TEXT NOT NULL, -- stable: '<file>:<scene name>'
  scene_file TEXT NOT NULL,
  scene_name TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL, -- 'queued' | 'running' | 'passed' | 'failed' | 'skipped'
  started_at INTEGER,
  ended_at INTEGER,
  summary_json TEXT
);
CREATE INDEX scene_executions_pr_scene_idx
  ON scene_executions(pr_number, scene_id, started_at DESC);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL, -- opaque JSON from scenetest-js
  ts INTEGER NOT NULL
);
CREATE INDEX events_run_seq_idx ON events(run_id, seq);

CREATE TABLE users (
  id TEXT PRIMARY KEY, -- google sub
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  last_login_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- CI Overview (bolt-on, secondary).
CREATE TABLE overview_issue_diffs (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, -- 'typecheck' | 'lint'
  state TEXT NOT NULL, -- 'new' | 'resolved' | 'shifted'
  file TEXT,
  line INTEGER,
  col INTEGER,
  message TEXT,
  raw TEXT
);
CREATE INDEX overview_issue_diffs_run_idx ON overview_issue_diffs(run_id, kind);

CREATE TABLE overview_summaries (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, -- 'typecheck' | 'lint'
  summary_json TEXT NOT NULL,
  PRIMARY KEY (run_id, kind)
);

CREATE TABLE overview_metrics (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, -- 'bundle.raw' | 'bundle.gzip' | ...
  base_value REAL,
  pr_value REAL,
  PRIMARY KEY (run_id, name)
);
