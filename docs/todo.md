# scenetest-cloud — To-do list

The real work lives in `architecture.md`: this file maps where the running
system falls short of that design. The open GitHub issues are mostly the
swept-up edges of larger pieces — they're cross-referenced below, but the
issue tracker is not the roadmap. The spine is.

What is built and proven today: the cloud plumbing end of the pipe. A webhook
creates a run, the PR Durable Object owns the event log in its SQLite, fans out
to viewers over a hibernation WebSocket, writes settled projections to D1, and
flushes each run's log to an R2 `.jsonl` artifact. The e2e exercises all of
that. **But everything it exercises is driven by the stub runner**, which
fabricates scenetest-shaped events straight into the coordinator's `/ingest`
and never touches a box. The half of the system that runs real tests on real
hardware is written and unproven.

Status legend: **spine** = a load-bearing path the design assumes works and
doesn't yet (or has never run) · **product** = promised to users, unbuilt ·
**deferred** = real, gated behind a named trigger · **cleanup** = the tracked
edges.

## spine — the runner path has never run

This is the big one. The cloud-to-box contract is fully coded — `ensureBox`
computes the stage plan and queues an `update`; `dispatch` rides the
coordinator's box channel; the agent's `applyUpdate` and `runBatch` handle
both — but the DigitalOcean provider has **never been exercised against the
live API** (`runner/digitalocean.ts:19`), and the stub path that the e2e runs
bypasses the box, the WebSocket dispatch, and the agent entirely. So the entire
right half of the event-flow diagram is theoretical:

- **First live provisioning, end to end.** One real PR: provision a droplet
  from the self-built image, the agent connects its outbound WebSocket, takes
  the queued `update`, checks out the sha, runs the pipeline stages, reports
  the realized vector via `/ready` — then a `dispatch` arrives, `runBatch`
  spawns the scenes command, the CLI streams events to the box-local ingest,
  they relay up the socket into the coordinator's log, and a `run:end` settles
  the verdict. **Every arrow in that sentence is untested.** No issue tracks
  this; it's the precondition for trusting anything below it.
- **An e2e that drives a box, not the stub.** Today's e2e proves the DO
  fan-out with fabricated events. Nothing covers the agent's
  dispatch→scenes→relay→verdict loop, the `update`→stage→`/ready` handshake, or
  the warm-box stage-diff reuse in `ensureBox`. Until a test boots the agent
  (even against a local fake droplet) and pushes an event through it, the
  runner is a design, not a feature.
- **The image build, verified.** `ensureImage` / `advanceImageBuilds` / the
  pending-box completion in `tick.ts` form a multi-step async chain that the
  stub never enters. First-live-provisioning is also the first real exercise of
  the snapshot build and the cron's pending-box pickup.

Until this path runs once, the stage cache, the warm-box reuse, idle teardown,
and reports-as-stages are all optimizations on top of an unproven foundation.

## product — the user-facing promises, still unbuilt

- **The run dashboard isn't consuming the live stream.** [#33] The coordinator
  fans out frames over the viewer WebSocket, but the cloud `Transport` adapter
  that feeds them into `@scenetest/dashboard` collections isn't wired —
  `sinceSeq` resume and seq-dedupe over partysocket. The widget exists; nothing
  yet drives it live in cloud. This is the "watch a run happen" half of the
  product.
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

## Notes

- **#16 and #24 are the same work** (home-view live layer) — consolidate.
- **First live provisioning and a box-driven e2e have no issues** — they're the
  spine, so they belong at the top of the tracker, not absent from it. File
  them.
- Dependency order: the spine gates the runner-dependent deferred items
  (idle teardown, save/restore). The two *product* items that don't touch the
  box — the live run dashboard (#33) and the home view (#24/#16) — can proceed
  in parallel with it, since both read the coordinator's already-proven
  fan-out.
