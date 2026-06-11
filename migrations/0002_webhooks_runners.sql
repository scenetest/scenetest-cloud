-- Webhook deliveries are recorded for idempotency (GitHub redelivers on
-- failure and on manual redeliver) and for debugging the trigger pipeline.
-- Payloads are NOT stored: GitHub's webhook UI keeps full payloads and can
-- redeliver them; D1 keeps metadata only.
CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY, -- X-GitHub-Delivery header
  event TEXT NOT NULL,          -- X-GitHub-Event header
  action TEXT,                  -- payload.action, when present
  repo TEXT,                    -- payload.repository.full_name
  pr_number INTEGER,
  received_at INTEGER NOT NULL,
  result TEXT                   -- 'run-created:<run_id>' | 'ignored:<reason>' | 'error:<detail>'
);
CREATE INDEX webhook_deliveries_received_idx ON webhook_deliveries(received_at DESC);

-- One row per provisioned VM. The reaper destroys any instance still alive
-- whose run has ended or whose age exceeds the cap, so a box never outlives
-- its run by more than one reaper cycle. `id` is the provider's instance id
-- (DigitalOcean droplet id) and doubles as runs.runner_id.
CREATE TABLE runner_instances (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, -- 'digitalocean' | 'stub'
  region TEXT,
  size TEXT,
  image TEXT,
  status TEXT NOT NULL,   -- 'provisioning' | 'active' | 'destroyed' | 'lost'
  created_at INTEGER NOT NULL,
  destroyed_at INTEGER
);
CREATE INDEX runner_instances_alive_idx ON runner_instances(status, created_at);
