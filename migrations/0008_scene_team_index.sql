-- The team a scene execution ran in. Two teams run the same scene in one run,
-- so without it the projection's row id collides and the two executions merge
-- into one row — which also drags the home tile's progress down, since it
-- counts settled rows against the run's own scene count.
ALTER TABLE scene_executions ADD COLUMN team_index INTEGER NOT NULL DEFAULT 0;

-- Superseded by team_index. Added in 0003 for this exact case ("the same scene
-- with a different team/actor-set is a distinct execution") and never read or
-- written since, so a reader looking for team handling finds it and stops at
-- the wrong column. The settle path needs an indexable column, not a blob.
ALTER TABLE scene_executions DROP COLUMN params_json;
