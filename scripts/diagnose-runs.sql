-- Runner diagnostic: how far do production runs actually get?
--
-- Run against PRODUCTION D1 (read-only; only SELECTs):
--   npx wrangler d1 execute scenetest-cloud-mhsnook --env production --remote \
--     --file scripts/diagnose-runs.sql
--
-- The --remote flag is REQUIRED — without it wrangler queries your empty local
-- copy. Or paste any single query below into the D1 web console.
--
-- Timestamps are epoch-milliseconds (Date.now()); datetime(x/1000,'unixepoch')
-- renders them in UTC. The funnel a run walks: created (queued) -> box built
-- -> droplet boots + agent connects -> `run:start` sets started_at ('running')
-- -> scene events fill scene_executions -> `run:end` settles the verdict.
-- Where the rows stop is where the pipeline stops.

-- 1. THE LINCHPIN: did the self-building runner image ever finish?
-- No 'ready' row here means no box ever got hardware, so every run can only
-- ever cancel. 'building' that never advances or 'failed' = the image machine
-- (builder droplet -> snapshot -> tick) is where it's stuck.
SELECT '=== 1. image stage_cache ===' AS section;
SELECT stage, input_hash, status, artifact_ref,
       datetime(created_at/1000,'unixepoch')  AS created,
       datetime(last_hit_at/1000,'unixepoch') AS last_hit
FROM stage_cache WHERE stage = 'image';

-- 2. Did any run EVER reach 'running'? (started_at is set only by run:start.)
-- If started_at is NULL on every row, no box ever emitted a single event —
-- tests never launched anywhere. If some are non-NULL, boxes DO run and the
-- problem is later (scenes failing / not reporting).
SELECT '=== 2. runs funnel (by status) ===' AS section;
SELECT status,
       COUNT(*)                              AS runs,
       SUM(started_at IS NOT NULL)           AS reached_running,
       SUM(ended_at  IS NOT NULL)            AS ended
FROM runs GROUP BY status ORDER BY runs DESC;

-- 3. Are there ANY scene_executions at all? Zero rows = no scene:start ever
-- landed = the scenes command never produced a test event on any box.
SELECT '=== 3. scene_executions total ===' AS section;
SELECT COUNT(*) AS scene_rows,
       SUM(status = 'running') AS still_running,
       SUM(status = 'passed')  AS passed,
       SUM(status = 'failed')  AS failed
FROM scene_executions;

-- 4. Boxes: how far each got. status 'provisioning' with a NULL
-- runner_instance_id = waiting on the image; 'ready' with a ready_at =
-- the agent connected and reported ready (the good path).
SELECT '=== 4. boxes (most recent 15) ===' AS section;
SELECT substr(id,1,8) AS box, repo, pr_number AS pr, status,
       substr(runner_instance_id,1,12) AS droplet,
       datetime(created_at/1000,'unixepoch') AS created,
       CASE WHEN ready_at IS NULL THEN '(never ready)'
            ELSE datetime(ready_at/1000,'unixepoch') END AS ready
FROM boxes ORDER BY created_at DESC LIMIT 15;

-- 5. Runner instances: did droplets get created, reach 'active', or die?
-- 'lost' = a destroy API call failed (go look at the DO console). Lots of
-- 'provisioning' that never went 'active' = droplets booting but the agent
-- never phoned home (image/boot/checkout problem).
SELECT '=== 5. runner_instances (by status) ===' AS section;
SELECT provider, status, COUNT(*) AS n,
       datetime(MAX(created_at)/1000,'unixepoch') AS newest
FROM runner_instances GROUP BY provider, status ORDER BY n DESC;

-- 6. The last 15 runs, joined to their box + droplet, with duration. A run
-- with a long duration but started_at NULL = box spent minutes building/booting
-- then the scenes command failed with no events (the /complete 'failed'
-- backstop). started_at NULL + short life ending 'cancelled' = swept before a
-- box was ever usable.
SELECT '=== 6. recent runs, end to end ===' AS section;
SELECT substr(r.id,1,8) AS run, r.pr_number AS pr, r.status,
       CASE WHEN r.started_at IS NULL THEN 'NEVER' ELSE 'yes' END AS ran,
       r.scene_count AS scenes_declared,
       (SELECT COUNT(*) FROM scene_executions se WHERE se.run_id = r.id) AS scene_rows,
       CASE WHEN r.ended_at IS NOT NULL AND r.started_at IS NOT NULL
            THEN (r.ended_at - r.started_at)/1000 END AS ran_secs,
       CASE WHEN r.ended_at IS NOT NULL
            THEN (r.ended_at - (SELECT b.created_at FROM boxes b WHERE b.id = r.box_id))/1000
       END AS secs_since_box,
       b.status AS box_status,
       ri.status AS droplet_status
FROM runs r
LEFT JOIN boxes b ON b.id = r.box_id
LEFT JOIN runner_instances ri ON ri.id = b.runner_instance_id
ORDER BY r.rowid DESC LIMIT 15;

-- 7. Sanity check the trigger path: are webhooks actually creating runs?
-- result like 'run-created:...' = the webhook fired createRun; 'ignored:...'
-- = filtered out (repo not watched, non-PR event, dedup).
SELECT '=== 7. recent webhook deliveries ===' AS section;
SELECT event, action, repo, pr_number AS pr, result,
       datetime(received_at/1000,'unixepoch') AS received
FROM webhook_deliveries ORDER BY received_at DESC LIMIT 12;
