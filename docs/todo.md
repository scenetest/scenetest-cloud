# scenetest-cloud — To-do list

A prioritized roadmap for the cloud service. The authoritative detail for each
item is its GitHub issue; this file is the ordering and dependency map across
them. The shape follows `architecture.md`'s "Order of work": protocol first,
then the dev-tool refactor (both done upstream), then the cloud service — which
is where everything below lives.

Status legend: **now** = on the critical path to the product promise ·
**next** = unblocked once *now* lands · **later** = real but deferred behind a
named trigger · **debt** = correctness/clarity cleanup, land anytime.

## now — make the live product actually live

The original day-one promise is two things that don't work end-to-end yet: a
run dashboard that updates as scenes resolve, and a home view that pushes a
notification when a job finishes. Both are wired structurally; neither is live.

- **[#33] Cloud `Transport` adapter (partysocket).** Feed the PR Durable
  Object's WebSocket stream into `@scenetest/dashboard` collections. The
  collection/source/projection layer already shipped upstream; this is only the
  adapter behind the `Transport` seam — frame unwrap, `sinceSeq` resume, and
  the load-bearing `seq`-dedupe. This is the closest item to "the run dashboard
  is live." *Pairs with the partysocket swap already in `cloudTransport.ts`.*

- **[#24 / #16] Home view live layer.** The largest unbuilt *section*: a
  per-workspace Durable Object above the per-PR coordinators, holding the live
  "all my PRs and their runs" snapshot, fanning out over a hibernation
  WebSocket, and firing Web Push on terminal run states (must work with no tab
  open). Today the Overview/Projects/RepoDetail shell exists but is D1 polling
  only. **These two issues are the same work** — #16 came out of the dashboard
  review, #24 from the architecture pass. Close one as a duplicate before
  starting so the backlog has a single source of truth.

## next — runner reaches production

The runner is stubbed by default (`RUNNER_PROVIDER = "stub"`); the DigitalOcean
path is written but cold.

- **First live DigitalOcean provisioning.** `runner/digitalocean.ts` carries
  the note *"NOT yet exercised against the live DigitalOcean API."* The code,
  the image build, and the box agent all exist — this is the validation pass
  that turns the stub into a real box: a single PR provisions a droplet, builds
  its image, streams events up its WebSocket, and tears down. **No tracked
  issue yet — file one.** Everything below gets easier to validate once this is
  proven once. *(Open PR #35 weighs Cloudflare Containers as an additive third
  provider — orthogonal; the DO path stays.)*

- **[#30] DO-alarm idle teardown.** Replace the blunt `RUNNER_MAX_AGE_MINUTES`
  age cap with an activity-reset Durable Object alarm owned by the PR
  coordinator; demote the cap to the hung-box backstop it's documented to be.
  `architecture.md` names the cap a placeholder explicitly. Wants a real box to
  validate against, so it sits behind first-live-provisioning.

- **[#27] Command semantics on the box.** The command transport is complete end
  to end, but the agent appends commands to `.commands.jsonl` and *nothing
  reads it* — "re-run as a different team," the first command the product ever
  imagined, re-runs nothing. Split by where each acts: `run:stop` is box-side
  (kill the batch, post `cancelled`); `run:replay` is really worker-side run
  creation via `createRun`; `pause`/`resume` depend on upstream CLI support.

## later — named-trigger work, don't build speculatively

Each of these is real and designed, with an explicit "build it when X" gate.
Pulling any forward before its trigger is observed adds surface for no payoff.

- **[#25] Reports-as-stages.** The `overview_*` tables have existed since
  migration 0001 and nothing writes them — they encode the original
  motivation screenshots (lint deltas, typecheck before/after, bundle-size
  base-vs-PR). Key reports by *stage input hash*, not run id, so dedupe across
  runs and PRs falls out for free. *Trigger: a real pipeline whose stages
  produce reports worth diffing.* Pairs naturally with the pipeline vocabulary.

- **[#26] Pipeline v1 (`save`/`restore`) and v2 (`toolchain`).** Both fields
  already parse-and-ignore in `parsePipeline`, so files written today survive
  the upgrade. v1 is the cold-path artifact cache (blocked on the R2 bucket,
  now landed in #23); v2 makes the env image a per-project stage. *Trigger:
  v1 when cold-box resurrection is painfully slow; v2 when a real project's
  `apt-get` in a `run` line hurts.*

- **[#28] Queues.** Decouple the coordinator's D1 write-through from the
  fan-out hot path and absorb webhook bursts. Explicitly optional and off the
  live path. *Trigger: measured D1 write latency delaying fan-out, webhook
  drops under burst, or D1 write contention in prod logs — none observed.*
  #23 landing reduces D1 ingest pressure, which may defer this indefinitely.

- **[#31] Analytics axis — Pipelines→Iceberg.** A derived second sink for
  cross-run rollups (flakiest scenes, p95 durations, pass-rate trends) behind
  R2 SQL, with `.jsonl` staying canonical. *Trigger: D1 metadata queries feel
  slow across many runs, product wants cross-run analytics, or CF Pipelines +
  R2 SQL reach GA.*

## debt — land anytime

Small, self-contained correctness/clarity fixes with no dependencies.

- **[#13] Routing: resolve `runId → DO` without the repeated D1 join.** Both
  `dashboardWs` and `postRunCommand` query D1 for `repo, pr_number` to name the
  coordinator. Recommended fix (Option A): denormalize a `do_name` column into
  `runs`, populated at `createRun`. Same round-trip, explicit intent, kills the
  repeated pattern. On the viewer-WS critical path, so worth doing alongside
  #33.

- **[#12] Move the `?session=` WS fallback out of shared `getSessionUser`.**
  The viewer-WS query-param token fallback leaked into the auth function every
  cookie-authed route runs through. Narrow blast radius, but it makes the
  shared auth path harder to audit. Fix: give `dashboardWs` its own auth via a
  `verifySessionToken` helper and drop the `withSession` wrapper for that route.

## Notes

- **#16 and #24 are duplicates** (home-view live layer) — consolidate.
- **First live DigitalOcean provisioning has no issue** — file one; it gates
  the whole *next* tier's validation.
- Dependency spine: #33 (run dashboard live) and #24/#16 (home view live) are
  independent and both *now*; everything in *next* wants first-live-provisioning
  proven; *later* items each wait on their own trigger, not on each other.
