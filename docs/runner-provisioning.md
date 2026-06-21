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
   (`src/worker/runner/create-run.ts`) calls `ensureBox()`, which computes
   the push's stage vector from the repo's pipeline file and git tree
   hashes ([pipeline.md](./pipeline.md)) and diffs it against what the live
   box has realized: no divergence reuses the box untouched; divergence at
   stage k cancels in-flight runs (latest wins) and sends the warm box an
   `update` to re-run stages k..end at the new sha; no live box provisions
   fresh hardware, minting the box's bearer token (stored only as a SHA-256
   hash).
3. The DigitalOcean provider (`src/worker/runner/digitalocean.ts`) creates
   one droplet from the `RUNNER_IMAGE` snapshot, passing box-level
   parameters via `user_data`, and records it in `runner_instances`. The run
   itself is dispatched through the PR's Durable Object
   (`src/worker/do/pr-coordinator.ts`) — queued until the box connects.
4. On the box, the image's `scenetest-runner` service runs the agent
   (`infra/box/agent.mjs`): it reads `/etc/scenetest/run.env`, clones the
   repo at `SCENETEST_HEAD_SHA`, and connects out to the box channel. The
   queued pipeline `update` arrives first (FIFO) and the agent runs its
   stages — app, database, seeds, the same code path as a developer's
   laptop — then reports the realized vector via
   `POST /api/boxes/:boxId/ready`.
5. The box holds one outbound WebSocket to
   `GET /api/boxes/:boxId/channel` (bearer-authed; header or `?token=`).
   Down it come `{ kind: 'dispatch', run }` batches and
   `{ kind: 'command', runId, command }` protocol commands; up it go
   `{ kind: 'events', runId, events: [{ seq, payload }] }` envelopes, which
   the coordinator appends to its SQLite log, fans out to viewers, and
   derives the D1 projections from (runs.status, scene_executions — at run
   boundaries, not per event). The box no longer reports scene_executions
   itself; `POST /api/runs/:runId/complete` remains as the terminal-state
   backstop (a non-zero exit with no `run:end` event).
6. An idle box is retired by the PR coordinator's Durable Object alarm
   (`PrCoordinator.alarm`), reset on every activity signal and firing
   `RUNNER_IDLE_TIMEOUT_MINUTES` (default 5) after the last one with the PR's
   runs settled — it marks the box `destroyed` (an in-flight run re-arms
   instead). The reaper (cron, every 10 minutes — `reapRunners()`) then
   destroys the droplet of any retired box, and hard-kills anything older than
   `RUNNER_MAX_AGE_MINUTES` (default 30) regardless of run state — the hung-box
   backstop for boxes the alarm never retired (a crashed object, a run that
   never settled). It marks droplets `destroyed` (or `lost` if the API call
   fails) and cancels any runs that never completed.

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

Box setup is driven by the repo's pipeline file (`scenetest/pipeline.json`,
spec in [pipeline.md](./pipeline.md)): the worker computes which stages a
push invalidated and sends them down the channel as an `update`; the agent
checks out the sha, runs them in order, and reports the realized stage
vector through `/api/boxes/:boxId/ready` (a failed stage retires the box).
Repos without a pipeline file get the coarse default, which runs
`scenetest/box-setup.sh` if present — the legacy hook keeps working.

The `update` also carries the **report plan** (#25): the cache-miss subset of
the pipeline's `reports`, each resolved to its input hash. After reporting
ready, the agent runs each one — built-in `loc` walks the watched files and
counts lines; a tool report (`lint`) runs its command and captures stdout —
and ships the raw output up its channel as `{kind:'report-raw', name, type,
inputHash, raw, root}`. The worker parses `raw` with the type's adapter and
upserts the `overview_*` tables, keyed by `(name, input_hash)` so identical
inputs share one report across runs and PRs. The box stays format-agnostic:
scenetest-cloud owns the parsers, so a parser fix never re-bakes the image.
Reports are best-effort — a failed report never blocks runs. (A stage may also
emit pre-normalized items directly to the agent's local `/reports/:stage`
ingest, relayed as `{kind:'report', …}`; the plan-driven path above is the
norm.) See architecture.md, "The build pipeline".

Scene batches run the pipeline file's top-level `scenes` command (default:
the legacy `bash scenetest/box-run.sh` hook), delivered to the agent with
every update. It receives `SCENETEST_RUN_ID`, `SCENETEST_SUBSET` (advisory;
the CLI has no `--subset`), `SCENETEST_LOCAL_INGEST` (base of the agent's
local relay), and `SCENETEST_REPORT_URL` — `@scenetest/scenes` ≥ 0.15 POSTs
its event batches there (`{events:[{seq,payload}]}`), the agent relays them
live, and a `run:end` event settles the verdict from its summary. A
non-zero exit marks the run failed, so no batch is left dangling.

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
| `RUNNER_IDLE_TIMEOUT_MINUTES` | var | idle teardown window, default 5 |
| `RUNNER_MAX_AGE_MINUTES` | var | hung-box backstop hard cap, default 30 |
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
