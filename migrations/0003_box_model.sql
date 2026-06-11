-- Per-PR box model. A box is the environment a PR's scene executions run in;
-- it outlives any single run. Runs become batches that own no infrastructure.
-- See architecture.md ("Cloud service", "The build pipeline").

-- One logical box per PR (at most one live). Holds the credential the box
-- reports with and the runner instance currently backing it. realized_stages
-- is the vector of build-stage input hashes the box currently embodies; the
-- PR coordinator diffs it against the desired vector to decide what a push
-- actually requires. (The hash computation itself lands with the pipeline
-- config format — see ensureBox.)
CREATE TABLE boxes (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,        -- commit the box is currently built for
  status TEXT NOT NULL,          -- 'provisioning'|'ready'|'rebuilding'|'idle'|'destroyed'
  bearer_token_hash TEXT NOT NULL,
  runner_instance_id TEXT,       -- current droplet backing the box
  realized_stages TEXT,          -- JSON { stage: input_hash }
  created_at INTEGER NOT NULL,
  ready_at INTEGER,
  last_used_at INTEGER,
  idle_deadline INTEGER,         -- when the PR coordinator should tear it down
  destroyed_at INTEGER,
  FOREIGN KEY (repo, pr_number) REFERENCES prs(repo, pr_number) ON DELETE CASCADE
);
-- At most one non-destroyed box per PR.
CREATE UNIQUE INDEX boxes_live_idx ON boxes(repo, pr_number) WHERE status != 'destroyed';

-- Global content-addressed cache: a build stage's output keyed by the hash of
-- its declared inputs. Shared across PRs, pushes, and rebases; never per-PR.
-- Artifact stages set artifact_ref; analysis stages set report_json; state
-- stages (db reset, deploy) set neither and a hit just means "skip".
CREATE TABLE stage_cache (
  stage TEXT NOT NULL,           -- 'image'|'deps'|'db'|'build'|'deploy'|...
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL,          -- 'building'|'ready'|'failed'
  artifact_ref TEXT,             -- registry tag / R2 key
  report_json TEXT,              -- bundle size, lint delta, typecheck delta, ...
  created_at INTEGER NOT NULL,
  last_hit_at INTEGER,
  PRIMARY KEY (stage, input_hash)
);

-- runs lose box ownership: the per-PR box owns the credential and the runner.
ALTER TABLE runs DROP COLUMN bearer_token_hash;
ALTER TABLE runs DROP COLUMN runner_id;
ALTER TABLE runs DROP COLUMN image_version;
ALTER TABLE runs ADD COLUMN box_id TEXT REFERENCES boxes(id) ON DELETE SET NULL;

-- A scene execution is parameterized: the same scene with a different
-- team/actor-set is a distinct execution. NULL = the scene's default.
ALTER TABLE scene_executions ADD COLUMN params_json TEXT;

-- runner_instances now hang off the box, not the run. Recreated rather than
-- altered (SQLite can't repoint a foreign key in place); no production data
-- exists on this column yet.
DROP TABLE runner_instances;
CREATE TABLE runner_instances (
  id TEXT PRIMARY KEY,           -- provider instance id (droplet id)
  box_id TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,        -- 'digitalocean' | 'stub'
  region TEXT,
  size TEXT,
  image TEXT,
  status TEXT NOT NULL,          -- 'provisioning'|'active'|'destroyed'|'lost'
  created_at INTEGER NOT NULL,
  destroyed_at INTEGER
);
CREATE INDEX runner_instances_alive_idx ON runner_instances(status, created_at);
