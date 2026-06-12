export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  // Durable record of run event logs. At end of run the events are assembled
  // into a .jsonl object here; D1's `events` rows are then prunable. Optional
  // so the worker still boots when the binding is absent (the artifact path
  // no-ops). Provisioned via `wrangler r2 bucket create` — see docs/setup.md.
  ARTIFACTS?: R2Bucket
  // One Durable Object per PR: box channel, command queue, event write-through.
  PR_COORDINATOR: DurableObjectNamespace
  // GitHub OAuth (identity)
  GITHUB_OAUTH_CLIENT_ID: string
  GITHUB_OAUTH_CLIENT_SECRET: string
  // First-login bootstrap: if allowed_user is empty AND the GitHub user's
  // login matches this value, they're inserted automatically. Subsequent
  // logins use the table normally.
  BOOTSTRAP_ALLOWED_LOGIN: string
  // Required for /webhook/github; the route returns 503 until it is set.
  GITHUB_WEBHOOK_SECRET?: string
  // Optional GitHub token (secret) for the trees/blobs/contents lookups the
  // pipeline stage-hashing makes at webhook time. Without it, unauthenticated
  // calls share the worker egress IP's 60/hr limit and hashing degrades to
  // the coarse rebuild-everything plan more often.
  GITHUB_API_TOKEN?: string
  SESSION_SECRET: string
  ENABLE_DEBUG_ROUTES?: string
  // How long a terminal run's events linger in D1 after its artifact is
  // written, before the cron sweep prunes them. Default 24 (hours). Set "0"
  // to prune as soon as the artifact exists (used by the e2e harness).
  EVENTS_RETENTION_HOURS?: string

  // Runner provisioning. RUNNER_PROVIDER selects the implementation:
  // 'stub' (default; writes fake events straight to D1) or 'digitalocean'.
  RUNNER_PROVIDER?: string
  // DigitalOcean provider config. DO_API_TOKEN is a secret; the rest are
  // plain vars. The runner image builds and caches itself from stock Ubuntu
  // (src/worker/runner/image.ts); RUNNER_IMAGE is an OPTIONAL pin that
  // bypasses the self-built snapshot — the escape hatch. PUBLIC_BASE_URL is
  // this deployment's origin (e.g. https://scenetest-cloud.example.workers.dev)
  // — the box needs it to reach the ingest API.
  DO_API_TOKEN?: string
  RUNNER_REGION?: string
  RUNNER_SIZE?: string
  RUNNER_IMAGE?: string
  PUBLIC_BASE_URL?: string
  // Hard cap on box lifetime in minutes (default 30). The reaper destroys
  // anything older regardless of run state.
  RUNNER_MAX_AGE_MINUTES?: string
}

export interface AuthedUser {
  github_id: number
  github_login: string
}
