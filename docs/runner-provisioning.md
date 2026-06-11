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
4. On the box, the image's `scenetest-runner` service runs the agent
   (`infra/box/agent.mjs`): it reads `/etc/scenetest/run.env`, clones the
   repo at `SCENETEST_HEAD_SHA`, runs the project's `scenetest/box-setup.sh`
   (app, database, seeds — the same code path as a developer's laptop),
   reports `POST /api/boxes/:boxId/ready`, and connects out to the box
   channel.
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

## The image builds itself

The runner image is the env-image stage of the build pipeline
(architecture.md), and it is self-building: there is no manual snapshot
step. `ensureImage()` (`src/worker/runner/image.ts`) keys the image by a
content hash of its inputs — the toolchain config (base Ubuntu slug, node
major, supabase CLI version), the builder cloud-init script, and the box
agent source — and looks it up in the global `stage_cache` table.

- **Hit:** boxes provision from the cached snapshot immediately.
- **Miss** (first run ever, or any input changed): the worker boots a
  builder droplet from stock `ubuntu-24-04-x64` whose cloud-init installs
  the toolchain — node + pnpm, git, docker, the supabase CLI, Playwright
  *system* deps (browsers are version-coupled to the project's playwright,
  so the project installs its own at box-setup time) — bakes in the agent
  and its systemd unit, neutralizes machine identity, and powers off.
  Power-off is the "done" signal; nothing ever SSHes in. The cron tick
  walks the build forward (off → snapshot → ready, builder destroyed),
  then provisions every box that was waiting and re-mints their tokens.
  ~10–15 minutes, once per toolchain change; meanwhile dispatched runs
  queue in the PR coordinator, so the first PR after a toolchain change is
  slow, not lost. Three failed attempts mark the hash `failed` and stop.

`RUNNER_IMAGE` remains as an escape hatch: setting it pins a snapshot id
and bypasses the self-built image entirely. To force a rebuild, delete the
image's `stage_cache` row.

The `scenetest-runner` unit is installed but deliberately **disabled** in
the image: `run.env` doesn't exist yet, so an enabled unit would crash-loop
at first boot. Provision-time `user_data` (written by
`src/worker/runner/digitalocean.ts`) creates `run.env` and starts it.

Nothing else crosses the boundary: no SSH keys are attached, the box only
ever connects outbound, and the bearer token it holds dies with the box.

### Project hooks

The agent drives the user's repo through two conventional scripts —
explicitly placeholders for the pipeline-config format from architecture.md:

- `scenetest/box-setup.sh` — bring up app, database, seeds (run once at
  checkout).
- `scenetest/box-run.sh` — execute one batch; receives `SCENETEST_RUN_ID`,
  `SCENETEST_SUBSET`, and `SCENETEST_LOCAL_INGEST` (the agent's local
  endpoint, which accepts the same body as the cloud ingest and relays up
  the channel). A missing script or non-zero exit marks the run failed, so
  no batch is left dangling.

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
| `RUNNER_REGION`, `RUNNER_SIZE` | var | droplet parameters |
| `RUNNER_IMAGE` | var | optional pin; normally unset (image self-builds) |
| `PUBLIC_BASE_URL` | var | this deployment's origin, for `SCENETEST_INGEST_URL` |
| `RUNNER_MAX_AGE_MINUTES` | var | hard kill cap, default 30 |
| `DO_API_TOKEN` | secret | droplet read/write + snapshot scope |

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

## Not built yet / untested

- **Nothing DigitalOcean-side has touched the live API yet.** The agent's
  channel behavior (ready, queue flush, command files, event relay) is
  covered by `pnpm e2e`, which spawns it in test mode against the real
  worker — but the self-building image (builder droplet, snapshot, tick
  state machine), droplet boot, checkout, and `box-setup.sh` runs are
  exercised only by the first real PR after `RUNNER_PROVIDER` flips.
- Viewer WebSockets from the coordinator (viewers currently read D1-backed
  SSE; the coordinator already writes through to D1, so this is a fan-out
  optimization, not a correctness gap).
- `.jsonl` artifact upload to R2 at end of run (the agent already writes
  `<runId>.jsonl` locally).
- The content-addressed stage cache (`stage_cache` table exists; `ensureBox`
  still rebuilds on any sha change).
- Richer command hand-off on the box: the agent appends commands to
  `<runId>.commands.jsonl` for the run script to consume; wiring them into
  the scenes CLI live comes with the receiver-core integration.
- Queued-command TTL: commands for a box that never connects sit in the
  coordinator's queue until the box is retired (retiring clears the queue).
