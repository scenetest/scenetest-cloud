# Runner provisioning

> This documents the implementation as it exists: one box per run. The
> target model is one box per PR with a content-addressed build pipeline —
> see the build pipeline and runner sections of
> [architecture.md](./architecture.md). The bearer-token, user_data, and
> reaper mechanics below carry over; the provisioning trigger and box
> lifetime change.

How a run goes from "GitHub said there's a new sha" to "an ephemeral
DigitalOcean box is executing scenes and reporting back," and how that box is
guaranteed to die. Background in [architecture.md](./architecture.md); setup
steps in [setup.md](./setup.md).

## Lifecycle

1. GitHub POSTs a `pull_request` event to `/webhook/github`
   (`src/worker/routes/webhook-github.ts`). The handler verifies the HMAC
   signature, drops duplicate deliveries (`webhook_deliveries` table), checks
   the repo against `watched_repo`, and upserts `prs`.
2. For `opened` / `synchronize` / `reopened`, `createRun()`
   (`src/worker/runner/create-run.ts`) inserts a `runs` row, mints the
   per-run bearer token (stored only as a SHA-256 hash), and calls the
   configured runner's `spawn()`. If the PR had a `next_push_filter` queued,
   it becomes the run's scene subset and is cleared.
3. The DigitalOcean runner (`src/worker/runner/digitalocean.ts`) creates one
   droplet from the `RUNNER_IMAGE` snapshot, passing per-run parameters via
   `user_data`, and records it in `runner_instances`.
4. On the box, the image's `scenetest-runner` service reads
   `/etc/scenetest/run.env`, clones the repo at `SCENETEST_HEAD_SHA`, brings
   up the app, database, seeds, and Playwright, and runs the scenes CLI —
   the same code path as a developer's laptop.
5. The box reports through the bearer-authed ingest API:
   `POST /api/events/:runId` (opaque scenetest-js events),
   `POST /api/runs/:runId/scene-executions` (status upserts), and finally
   `POST /api/runs/:runId/complete`.
6. The reaper (cron, every 10 minutes — `reapRunners()`) destroys droplets
   whose run has ended and anything older than `RUNNER_MAX_AGE_MINUTES`
   (default 30), marking them `destroyed` (or `lost` if the API call fails)
   in `runner_instances`.

## The image contract

`RUNNER_IMAGE` is a DO snapshot we build (manually for now). It must contain:

- Node + pnpm, git, Playwright with browsers and OS deps.
- A `scenetest-runner` systemd unit, enabled but not started, that:
  1. sources `/etc/scenetest/run.env`,
  2. clones `SCENETEST_REPO` at `SCENETEST_HEAD_SHA` (shallow),
  3. runs the project's setup (install, db, seeds) and the scenes CLI with
     `SCENETEST_SUBSET` if non-empty,
  4. POSTs events/executions/complete to `SCENETEST_INGEST_URL` using
     `SCENETEST_BEARER_TOKEN`,
  5. powers off when done (`systemctl poweroff`) — the reaper still
     destroys the droplet; poweroff just stops billing-relevant work and
     closes the box early.

The worker writes `run.env` via `user_data` and starts the unit. Nothing
else crosses the boundary: no SSH keys are attached, the box only ever
connects outbound, and the bearer token it holds is valid for this one run.

### run.env variables

| Variable | Meaning |
|---|---|
| `SCENETEST_RUN_ID` | id of the `runs` row |
| `SCENETEST_REPO` | `owner/name` |
| `SCENETEST_HEAD_SHA` / `SCENETEST_BASE_SHA` / `SCENETEST_BASE_REF` | what to test |
| `SCENETEST_SUBSET` | JSON array of scene_ids, empty = all |
| `SCENETEST_INGEST_URL` | origin of this deployment (`PUBLIC_BASE_URL`) |
| `SCENETEST_BEARER_TOKEN` | single-run ingest credential |

Private repo cloning is unresolved: the box currently has no git credential.
Options, in rough order of preference: a GitHub App installation token
minted per run and added to `run.env`; a read-only deploy key baked per
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
end-to-end before any DO setup.

## Invariants

- User code executes only on the disposable box, never in the worker.
- The bearer token's plaintext exists in two places: the box's `run.env`
  and the spawn request that wrote it. D1 holds only the hash.
- Every `runner_instances` row reaches `destroyed` or `lost`; `lost` rows
  are a signal to go look at the DO console, not a steady state.
- Webhook handling is idempotent per `X-GitHub-Delivery` id.

## Not built yet

- Live streaming from box to viewers (currently events land in D1 and reach
  the dashboard via SSE polling of the bridge; the Durable Object live path
  in architecture.md replaces that).
- `.jsonl` artifact upload to R2 at end of run.
- Commands down to the box (re-run as different team) — requires the box's
  outbound WebSocket to the run's Durable Object.
- Image build automation (Packer or a build script; snapshots are manual
  for now).
