# scenetest-cloud — To-do list

The real work lives in `architecture.md`: this file maps where the running
system falls short of that design. The open GitHub issues are mostly the
swept-up edges of larger pieces — they're cross-referenced below, but the
issue tracker is not the roadmap. The spine is.

What is built and proven today: the cloud plumbing end of the pipe. A webhook
creates a run, the PR Durable Object owns the event log in its SQLite, fans out
to viewers over a hibernation WebSocket, and flushes each run's log to an R2
`.jsonl` artifact. Boxes provision and the agent connects. **But everything the
e2e exercises is driven by the stub runner**, and the stub does something the
real path doesn't: it hand-writes every D1 projection inline (see the gap
below). Strip it away and the dashboard goes dark even while the live log
fills.

Status legend: **spine** = a load-bearing path the design assumes works and
doesn't yet · **product** = promised to users, unbuilt · **deferred** = real,
gated behind a named trigger · **cleanup** = the tracked edges.

## Landing now — the per-PR dashboard

The `claude/per-pr-dashboard` branch (merging today) is the architecture's
"one-collection-per-PR" work — the thing the doc anticipates when it parentheses
"*a per-PR object-assigned cursor and a channel discriminator arrive with the
one-collection-per-PR dashboard work*." It:

- retires `/r/:runId` — the **PR** is the unit; runs are picked in-page
  (`?run=`) under `/repo/:owner/:name/pr/:number`;
- gives the DO log a **PR-global autoincrement `id`** (`UNIQUE(run_id, seq)`,
  `INSERT OR IGNORE … RETURNING id`) and streams the whole PR over one socket
  (`/pr-viewer-connect?sinceId`) via a new `createCloudPrTransport`;
- re-folds R2-archived runs back into the PR stream under their original id
  (`rehydrateArchived`, `POST /reset`).

Two consequences for this list. **(1)** It largely implements / supersedes #33 —
the cloud `Transport` adapter is now the PR-anchored `createCloudPrTransport`,
not a per-run one; reconcile #33 against the merge rather than building it
fresh. **(2)** Its ~200-line rework of `pr-coordinator.ts` is all PR-global
ordering and rehydration — **no D1 projection writes** — so the spine gap below
survives the merge, and the projection writer (#36) must be built on the
*post-merge* ingest path (the `RETURNING id` one), not today's.

## The box agent / relay — landed (answering a recurring question)

The "piece of technology maintained in this repo, embedded on the box, that
relays data up to the Durable Object and resolves protocol-version skew" is the
**box agent** (`infra/box/agent.mjs`), landed in `d96aa04`. The version-skew
resolution is its **envelope-grade relay rule**: it forwards opaque
`{seq, payload}` frames upstream without parsing them, so event types newer than
the relay pass straight through (`architecture.md` → "Receiver core" is the
decision record; the cloud deliberately does *not* run `@scenetest/receiver`).
The *log-tailing* form specifically did **not** survive: the agent originally
tailed a `.jsonl` events file, and `404fdee` deleted that tail/sweep machinery
when scenetest CLI 0.15 shipped `--report-url` — the CLI now POSTs event batches
to the agent's local HTTP ingest instead. So the relay landed; the tail was
replaced by a push. Nothing to build here; recorded so it stops being re-asked.

## spine — the projection writer was never built; the stub impersonates it (#36)

This is the big one, and it's narrower than "the runner doesn't work." Boxes
*do* provision, the agent connects, takes its `update`, and a `dispatch` runs
the scenes command — and events *do* relay up the socket into the coordinator's
SQLite log and fan out to live viewers. What's missing is the step that turns
that log into the D1 projections the dashboard reads.

`architecture.md` says *"the object writes settled projections to D1 at run
boundaries."* It doesn't. `PrCoordinator.ingestAndFanout`
(`do/pr-coordinator.ts:199`) only appends to its log and fans out — it writes
**no D1 row**. The agent reports events up the socket and calls `/ready` and
`/complete`, but never `/scene-executions`, and nothing advances `runs.status`
to `running`. The only thing standing in for the missing projection writer is
the **stub** (`runner/stub.ts`), which hand-writes every projection as it
fabricates events — `runs.status='running'` + `started_at`, the
`scene_executions` rows, the terminal verdict. That's why the e2e looks
healthy and a real box looks dead.

Concretely, on a real (non-stub) run:

- **`runs` never goes `running`.** It sits at `queued` until the agent's
  `/complete` flips it straight to a terminal verdict. No `started_at`, no
  in-progress state — the run lists show nothing happening, then a result.
- **`scene_executions` is never written.** A `postSceneExecutions` endpoint
  exists (`routes/runner-ingest.ts:32`) and is wired in the router, but the
  agent never calls it and the coordinator never derives scene rows from
  `scene:start` / `scene:end`. The per-scene grid is empty for every real run.
- **The `overview_*` rollups are never written** — same root cause, and the
  reason the home view has no live data (this is the projection half of #24/#25;
  the root is here).

**The fix is one component: a projection writer in the PR coordinator.** It
already ingests every event into its log — have `ingestAndFanout` (or a
boundary hook it calls) derive and upsert the D1 projections the architecture
promised: `run:start` → `runs` running + `started_at`; `scene:start` /
`scene:end` → `scene_executions` upserts; `run:end` → settled verdict + score +
`overview_*` rollups. The architecture is explicit that this belongs to the
*object* (it owns the log), not the agent making extra HTTP calls — so the
`/scene-executions` endpoint is the wrong locus and can be retired once the
coordinator projects. Once this lands, delete the stub's hand-written
projection writes: the same code path must serve both, or the stub goes on
hiding the gap.

Supporting work, flushed out by the same effort:

- **A box-driven e2e (#37).** Today's e2e proves the DO fan-out with fabricated
  events; nothing covers the agent's dispatch→scenes→relay→**projection**
  loop. A test that boots the agent (against a local fake droplet, using its
  `SCENETEST_SKIP_CHECKOUT` / `SCENETEST_NO_POWEROFF` hooks) and pushes a real
  event through to a D1 projection is what would have caught this. Until then
  the stub's inline writes mask the missing writer by construction.
- **Live-path validation of the rest of the chain (#38).** With the projection
  writer in place, confirm the warm-box stage-diff reuse in `ensureBox`, the
  `update`→stage→`/ready` handshake, and the image-build / pending-box pickup
  in `tick.ts` against a real droplet — the DigitalOcean provider is otherwise
  only unit-tested (`runner/digitalocean.ts:19`).

## product — the user-facing promises, still unbuilt

- **The run dashboard's live stream — mostly landing via the per-PR branch.**
  [#33] The cloud `Transport` adapter that feeds the coordinator's WebSocket
  into `@scenetest/dashboard` collections is being delivered as the PR-anchored
  `createCloudPrTransport` (see "Landing now"). Treat #33 as a reconcile-against-
  the-merge item, not greenfield: confirm `sinceId` resume + dedupe and the
  widget mount survived, then close or re-scope it.
- **The home view doesn't update and doesn't notify.** [#24 / #16 — duplicates,
  consolidate] The largest unbuilt *section* of the architecture and the
  day-one promise ("it sends me a notification when a job is done"). Needs a
  per-workspace Durable Object above the PR coordinators, `run.progress`
  rollups emitted upward, a hibernation fan-out to the home dashboard, and Web
  Push on terminal states (must fire with no tab open). Today the
  Overview/Projects/RepoDetail shell is D1 polling only — the "60% done, 1
  failing" tiles never move.
- **Commands are inert on the box.** [#27] The command transport is complete
  end to end — viewer → worker → coordinator queue → box socket — but the agent
  appends each command to `runs/<id>.commands.jsonl` and **nothing reads it**.
  "Re-run as a different team," the first command the product ever imagined,
  re-runs nothing. `run:stop` is box-side (kill the batch, post `cancelled`);
  `run:replay` is really worker-side run creation via `createRun`.
- **The PR comparison view has no data.** [#25] The `overview_*` tables have
  existed since migration 0001 and nothing writes them — they encode the
  original motivation screenshots (lint deltas, typecheck before/after,
  bundle-size base-vs-PR). Reports are stage outputs keyed by stage input hash,
  so identical inputs share one report across runs and PRs; the comparison is
  "report at base hash vs head hash." Pairs with the pipeline vocabulary.

## deferred — real, but gated on a named trigger

Each is designed; pulling it forward before its trigger adds surface for no
payoff.

- **Idle teardown.** [#30] `RUNNER_MAX_AGE_MINUTES` (default 30) destroys every
  box past the cap, warm ones included — `architecture.md` names it the
  placeholder. The target is a DO alarm owned by the PR coordinator, reset on
  activity, with the cap demoted to the hung-box backstop. *Wants a live box to
  validate against — sits behind the spine.*
- **Pipeline `save`/`restore` (v1) and `toolchain` (v2).** [#26] Both fields
  already parse-and-ignore in `parsePipeline`. v1 is the cold-path artifact
  cache (the `stage_cache.artifact_ref` column waits); v2 makes the env image a
  per-project stage. *Trigger: cold-box resurrection is slow (v1); a real
  project's `apt-get` in a run line hurts (v2).*
- **Queues.** [#28] Decouple the coordinator's D1 write-through from fan-out and
  absorb webhook bursts. Explicitly off the live path. *Trigger: measured D1
  write latency delaying fan-out, webhook drops under burst, or D1 contention
  in prod.*
- **Analytics axis — Pipelines→Iceberg.** [#31] A derived second sink for
  cross-run rollups behind R2 SQL, `.jsonl` staying canonical. *Trigger: D1
  metadata queries feel slow across many runs, or product wants cross-run
  analytics.*
- **Cloudflare Containers as a third runner provider.** [PR #35] Decision
  record in flight; additive to the DO path, gated on a spike (nested-virt
  blocker for the Docker-based Supabase stack).

## cleanup — the tracked edges, land anytime

- **[#13] Resolve `runId → DO` without the repeated D1 join.** Both
  `dashboardWs` and `postRunCommand` query D1 for `repo, pr_number` to name the
  coordinator. Recommended: denormalize a `do_name` column into `runs` at
  `createRun`. On the viewer-WS critical path — do it alongside #33.
- **[#12] Move the `?session=` WS fallback out of shared `getSessionUser`.**
  The viewer-WS query-param token fallback leaked into the auth function every
  cookie-authed route runs through. Give `dashboardWs` its own auth via a
  `verifySessionToken` helper.

## Tracker map

Every architecture.md gap now has an issue. The spine ones were filed off this
audit; the rest pre-existed.

- Spine: **#36** projection writer · **#37** box-driven e2e · **#38** live-DO
  validation.
- Product: **#33** run-dashboard transport (largely the per-PR branch) ·
  **#24/#16** home-view live layer · **#27** box command semantics ·
  **#25** reports-as-stages.
- Deferred: **#30** idle teardown · **#26** pipeline v1/v2 · **#28** queues ·
  **#31** analytics · **PR #35** CF Containers.
- Cleanup: **#13** runId→DO routing · **#12** session WS auth.
- Already built (no work): R2 archive (#23), DO→viewer WS fan-out, pipeline v0,
  three-surface auth, the box agent / envelope relay.

## Notes

- **#16 and #24 are the same work** (home-view live layer) — consolidate. Their
  *live* layer sits on top of the spine: the rollups they fan out are D1
  projections nothing currently writes (#36).
- Dependency order: the spine (#36) gates everything the dashboard reads from
  D1 — run lists, scene grids, the home-view rollups. The run-dashboard
  transport (#33) is the one product item that *doesn't* depend on it, since it
  reads the coordinator's WebSocket fan-out rather than D1, and it's largely
  landing on the per-PR branch anyway. The runner-dependent deferred items
  (idle teardown #30, save/restore #26) wait on live-path validation (#38)
  alongside the spine.
