-- The run's scene total, asserted by the run:start event. The home view derives
-- a progress % from it (settled scene_executions / scene_count) — and it lets
-- the HomeCoordinator recompute that % when it rebuilds its live cache from D1.
-- NULL for runs created before run:start lands (or before this migration).
ALTER TABLE runs ADD COLUMN scene_count INTEGER;
