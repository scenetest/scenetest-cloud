# Runner provisioning

How a PR goes from "GitHub said there's a new sha" to "an ephemeral
DigitalOcean box is executing scenes and reporting back," and how that box is
guaranteed to die. One box per PR; runs are batches dispatched to it.
Background in [architecture.md](./architecture.md); setup steps in
[setup.md](./setup.md).

## Lifecycle

1. GitHub POSTs a `pull_request` event to `/webhook/github`
   (`src/worker/routes/webhook-github.ts`). The handler verifies the HMAC
   signature, drops duplicate deliveries (`webhook_deliveries` table), checks
   the repo against `watched_repo`, and upserts `prs`.
2. For `opened` / `synchronize` / `reopened`, `createRun()`
   (`src/worker/runner/create-run.ts`) calls `ensureBox()`: reuse the PR's
   live box if its `head_sha` matches, otherwise retire it (cancelling its
   unfinished runs — latest wins — and closing its channel) and provision a
   fresh one, minting the box's bearer token (stored only as a SHA-256
   hash). The content-addressed stage diff from architecture.md replaces the
   sha-equality check once the pipeline-config format exists.
3. The DigitalOcean provider (`src/worker/runner/digitalocean.ts`) creates
   one droplet from the `RUNNER_IMAGE` snapshot, passing box-level
   parameters via `user_data`, and records it in `runner_instances`. The run
   itself is dispatched through the PR's Durable Object
   (`src/worker/do/pr-coordinator.ts`) — queued until the box connects.
4. On the box, the image's `scenetest-runner` service reads
   `/etc/scenetest/run.env`, clones the repo at `SCENETEST_HEAD_SHA`, brings
   up the app, database, seeds, and Playwright — the same code path as a
   developer's laptop — then connects out to the box channel.
5. The box holds one outbound WebSocket to
   `GET /api/boxes/:boxId/channel` (bearer-authed; header or `?token=`).
   Down it come `{ kind: 'dispatch', run }` batches and
   `{ kind: 'command', runId, command }` protocol commands; up it go
   `{ kind: 'events', runId, events: [{ seq, payload }] }` envelopes, which
   the coordinator writes through to D1 (where the SSE endpoint serves
   viewers). The HTTP ingest API remains valid for batched reporting:
   `POST /api/runs/:runId/scene-executions` and
   `POST /api/runs/:runId/complete`.
6. The reaper (cron, every 10 minutes — `reapRunners()`) destroys droplets
   whose box is retired and anything older than `RUNNER_MAX_AGE_MINUTES`
   (default 30), marking them `destroyed` (or `lost` if the API call fails)
   and cancelling any runs that never completed.

## The image contract

`RUNNER_IMAGE` is a DO snapshot we build (manually for now). It must contain:

- Node + pnpm, git, Playwright with browsers and OS deps.
- A `scenetest-runner` systemd unit, enabled but not started, that:
  1. sources `/etc/scenetest/run.env`,
  2. clones `SCENETEST_REPO` at `SCENETEST_HEAD_SHA` (shallow),
  3. runs the project's setup (install, db, seeds),
  4. connects the box channel WebSocket and executes the scene batches it
     dispatches, reporting events back up the socket (scene-execution
     upserts and run completion via the HTTP ingest API),
  5. powers off when its channel closes with "box retired" — the reaper
     still destroys the droplet; poweroff just stops billing-relevant work
     early.

The worker writes `run.env` via `user_data` and starts the unit. Nothing
else crosses the boundary: no SSH keys are attached, the box only ever
connects outbound, and the bearer token it holds dies with the box.

### run.env variables

| Variable | Meaning |
|---|---|
| `SCENETEST_BOX_ID` | id of the `boxes` row; names the channel URL |
| `SCENETEST_REPO` | `owner/name` |
| `SCENETEST_HEAD_SHA` / `SCENETEST_BASE_SHA` / `SCENETEST_BASE_REF` | what to build |
| `SCENETEST_INGEST_URL` | origin of this deployment (`PUBLIC_BASE_URL`) |
| `SCENETEST_BEARER_TOKEN` | the box's credential (channel + ingest API) |

Scene subsets are not box-level: they arrive per run inside `dispatch`
batches.

Private repo cloning is unresolved: the box currently has no git credential.
Options, in rough order of preference: a GitHub App installation token
minted per box and added to `run.env`; a read-only deploy key baked per
watched repo. Public repos work without either.

## Configuration

| Name | Kind | Notes |
|---|---|---|
| `RUNNER_PROVIDER` | var | `stub` (default) or `digitalocean` |
| `RUNNER_REGION`, `RUNNER_SIZE`, `RUNNER_IMAGE` | var | droplet parameters |
| `PUBLIC_BASE_URL` | var | this deployment's origin, for `SCENETEST_INGEST_URL` |
| `RUNNER_MAX_AGE_MINUTES` | var | hard kill cap, default 30 |
| `DO_API_TOKEN` | secret | droplet read/write scope |

The stub provider (`runner/stub.ts`) fabricates a plausible run in-worker
and needs none of these; it is the default so a fresh deployment works
end-to-end before any DigitalOcean setup.

## Invariants

- User code executes only on the disposable box, never in the worker.
- The bearer token's plaintext exists in two places: the box's `run.env`
  and the provision request that wrote it. D1 holds only the hash.
- At most one live box per PR (unique partial index), and at most one
  connected box channel per coordinator (a new connection replaces the old).
- Every `runner_instances` row reaches `destroyed` or `lost`; `lost` rows
  are a signal to go look at the DigitalOcean console, not a steady state.
- Webhook handling is idempotent per `X-GitHub-Delivery` id.

## Not built yet

- The box bootstrap itself (the systemd unit's script — the cloud side of
  the channel is live and exercised by `pnpm e2e`, which plays the box).
- Viewer WebSockets from the coordinator (viewers currently read D1-backed
  SSE; the coordinator already writes through to D1, so this is a fan-out
  optimization, not a correctness gap).
- `.jsonl` artifact upload to R2 at end of run.
- The content-addressed stage cache (`stage_cache` table exists; `ensureBox`
  still rebuilds on any sha change).
- Image build automation (Packer or a build script; snapshots are manual
  for now).
- Queued-command TTL: commands for a box that never connects sit in the
  coordinator's queue until the box is retired (retiring clears the queue).
