# Scenetest Cloud — Architecture

Scenetest runs end-to-end tests with inline assertions: a Vite plugin injects
a listener into the app under test, a CLI drives Playwright sessions, and a
dashboard shows assertion results live. This document describes how the dev
tool and the cloud service share one architecture.

## Repository layout

Code is grouped by release channel and deploy cadence rather than by topic.

| Repo | Contents | Ships as | Cadence |
|---|---|---|---|
| `scenetest/scenetest-js` | Vite plugin, CLI (`scenes`), `checks` + framework bindings, `protocol`, `dashboard`, receiver core | npm packages, run inside users' projects | Versioned releases; users sit on old versions indefinitely |
| `scenetest/scenetest-cloud` (this repo) | Worker, Durable Object classes, D1 schema/migrations, Queue consumers, runner-box provisioning | Deployed by us to our Cloudflare account | Continuous deploy; one live version |

The seam between the two repos is a published package and a wire protocol. A
service deploy and an npm release should never need to be atomic; if they do,
the protocol versioning has failed.

## The protocol package

Every part of the system produces or consumes events:

- Producers: the injected client listener (assertion results), the CLI
  (Playwright actions, driver failures), the human (commands like "re-run as
  a different team").
- Consumers: the dashboard (live view), the recorder (`.jsonl` in dev,
  R2 + D1 in cloud), the CLI (its instruction queue).

`@scenetest/protocol` is a small versioned package defining the typed event
and command vocabulary plus serialization. It lives in the monorepo and is
published to npm because:

1. Most of its consumers (CLI, plugin, dashboard) live there.
2. The open-source tool has to work without the cloud service existing, so
   the dependency arrow points from cloud to toolkit and never the reverse.
3. Users run last month's CLI against today's worker. Routing wire-format
   changes through a published release keeps version skew visible.

Everything below is an implementation behind this vocabulary, and can be
swapped without changing it.

## Shared components

These live in the monorepo and are consumed by both the Vite plugin and this
repo.

### Receiver core

`@scenetest/receiver` is the server-side listening half of the event
pipeline — accepts protocol-event POSTs, hands them to a pluggable sink —
extracted from the Vite plugin and published in 0.11. Dev mode runs it: the
`/__scenetest` middleware is the receiver mounted in Vite's connect server.

The cloud deliberately does **not** run it, which is a revision of this
document's original plan (a shared Hono app on the Worker and in Durable
Objects). What the two environments actually share is the **wire
contract** — the protocol package and its envelope-grade relay rule — not
the server code. The cloud's ingest surfaces turned out to be mostly glue
around that contract: bearer auth via a D1 join, forwarding to the PR
coordinator, sequence bookkeeping. The shareable parsing inside them is a
few lines, kept deliberately minimal so events newer than the relay pass
through. The worker keeps its small hand-rolled router for the same reason.

Conditions for revisiting: the box agent (whose local relay hand-rolls the
receiver's job in ~40 lines) adopts the package if it ever grows a bundling
step for other reasons — the agent is single-file, zero-dependency by
design, and that property currently outweighs the dedupe. And any future
standalone or self-hosted relay should be the receiver package outright;
that is its design center.

### Dashboard widget

The Preact dashboard is packaged as a mountable widget:

```ts
mountDashboard(element, { transport })
```

The widget renders the same UI in dev and cloud; the host page supplies a
transport adapter and a DOM element, nothing else. It mounts into any host —
the `/__scenetest` route, a worker-served page, an Astro island — without
requiring the host to use Preact.

### The transport adapter

The injection point where dev and cloud differ. The widget calls the adapter
to fetch state and subscribe to live events; the adapter speaks to whatever
backend is present. In dev that is the Vite middleware (fetch + SSE); in
cloud it is the worker API (fetch + WebSocket). Because the difference
between the two environments is confined to this object, the dashboard
behaves the same in both by construction.

### Candidate primitive: StreamDB / Durable Streams

We hand-roll a cluster of related machinery — resumable replay (WS and SSE),
the transparent D1-then-R2 backfill switch, snapshot-then-deltas on both the
run view and the home view, and the event-ordering contract that ties them
together. ElectricSQL's **Durable Streams** (an open HTTP protocol for
persistent, resumable, addressable streams) and **StreamDB** (a reactive,
TanStack-DB-backed database materialized from such a stream) are the
off-the-shelf shape of exactly that machinery.

Not adopting now — but tracking it as the thing we would otherwise keep
building ourselves. The usual 0.1.0 caution does **not** gate this: we have
already invented the equivalent primitives, so hitting a rough edge means
working with the library team to fix it upstream, which is welcome rather
than a risk. What we are actually looking for is one primitive that combines:

1. A server that runs in dev, from plain Node, or from a Durable Object, and
   exposes the stream over hibernating WebSockets, non-hibernating
   WebSockets, or SSE — with connect + backfill, implementing our
   data-ordering (or at least sequencing) contract.
2. A client where `const { db } = createTransportDB(settings)` returns the
   desired TanStack DB collections whose updates are carried in the stream.
3. (optional) a way to watch SQLite or the Postgres WAL to source events
   server-side.
4. (optional) a way for clients to send events back upstream and fan them out
   to other watchers.

The non-negotiable constraints if we do adopt it: it sits **behind**
`@scenetest/protocol` as a transport/persistence implementation, carrying our
events as payload — never as the wire vocabulary (the one expensive decision
stays ours). The real gating question is fit, not maturity: chiefly whether
its connection model preserves the WebSocket-hibernation cost story this
design depends on, since an always-on SSE/WS stream would reintroduce idle
billing the rest of the architecture works to avoid. The natural slot is
this transport adapter (and its server-side counterpart, the receiver core);
the zero-dependency box agent is not a candidate.

## Dev mode

The Vite plugin is a thin, same-origin adapter: it injects the listener,
mounts the receiver core as middleware, serves the dashboard at
`/__scenetest`, and uses an append-to-`.jsonl` sink. Same-origin matters
here — no CORS, no extra port, works in Codespaces and devcontainers — so
the middleware stays; it is a small wrapper over the shared core.

## Cloud service (this repo)

Units of work, smallest to largest: a scene execution is the atomic unit
and is parameterized (the same scene with a different team is a different
execution); a run is a batch of executions triggered together — a push
triggers a batch of all scenes, a manual re-run is a batch of one — and
owns no infrastructure; a box is the environment a PR's executions run in;
the PR is the unit of coordination, because a PR getting merged is the goal
the whole system serves.

Each Cloudflare primitive has one job:

- The worker (Hono) handles API routes and auth, serves the dashboard shell
  and static assets, and routes run traffic to Durable Objects. The shell is
  Preact, same as the widget. React-flavored libraries (e.g. TanStack Query)
  are consumed through the standard `preact/compat` alias; `react` and
  `react-dom` never enter the dependency tree.
- One Durable Object per PR is the coordination point. It owns the box's
  lifecycle (when to provision, what a push actually requires — see the
  build pipeline below — and when to tear down), accepts the box's outbound
  WebSocket on one side, fans out to dashboard viewers on the other
  (WebSocket hibernation API), and holds the pending command queue.
- D1 holds metadata only — runs, scores, failures; enough to render lists
  and link into R2 — and never log lines. D1 caps at 10 GB, so append-heavy
  event logs are kept out of it by design rather than as a later
  optimization.
- R2 holds the durable record (`ARTIFACTS` bucket): at end of run the event
  log becomes a `.jsonl` object — the source of truth for raw events, with
  historical detail views reading it through the worker. The local file is
  not a backup of the database — persisting it is the point. The worker
  assembles the artifact from D1 (every event already transits it) rather
  than the box uploading directly; presigned-URL box uploads can replace
  this if event volume ever outgrows D1 transit. Mechanics: at completion
  (stub finish and `postRunComplete`, best-effort via `waitUntil`) the run's
  events are written to `runs/<repo>/<runId>.jsonl` and `runs.artifact_key`
  is set. The cron sweep is the guarantee — terminal runs missing a key get
  one, then the `events` rows of artifacted runs older than
  `EVENTS_RETENTION_HOURS` (default 24) are pruned, so D1 holds metadata and
  never accumulates log lines. Once a run's rows are gone the viewer replay
  (WS and SSE) and `GET /api/runs/:runId/log` serve from the artifact
  instead — same frames, transparent to the client. (Not R2 SQL: that queries
  Iceberg tables, not `.jsonl`, and this path is a keyed point read. R2 SQL is
  the analytics axis — cross-run rollups, the `overview_*` tables — and if that
  outgrows D1 the move is Pipelines→Iceberg as a derived second sink, `.jsonl`
  staying canonical.)
- Queues (optional) decouple Durable Object write-through from D1 metadata
  updates and absorb webhook bursts. They are not on the live path.

### Runner

One ephemeral DigitalOcean box per PR — not per run. The box runs the same
code path as a developer's laptop: app under test, database, seeds,
Playwright, the scenes CLI, the agent's local relay — all local to the box,
so scene executions stay atomic. A laptop is a persistent environment you run tests against
repeatedly; the per-PR box is the faithful analog of that, and a re-run
against a warm box costs seconds, not a provisioning cycle.

Configuration is the only difference from dev mode: the box's sink writes
the local `.jsonl` (debug + artifact) and also streams events up the box's
single outbound WebSocket to the PR's Durable Object. Outbound-only means
no inbound firewall holes; commands ride the same socket back down.

Powered-off droplets still bill, so idle boxes are destroyed, not parked,
and the build pipeline's cache makes resurrection cheap (boot the cached
image, replay invalidated stages). The warm box is a performance
optimization; the cache is the correctness story.

Today's teardown is cruder than the target: the reaper's hard age cap
(`RUNNER_MAX_AGE_MINUTES`, default 30) destroys *every* box past it,
healthy-and-warm included — so warm reuse only exists inside that window,
and a long-lived PR rebuilds its box twice an hour. The target is an
idle-based teardown owned by the PR object (a Durable Object alarm reset on
activity), with the age cap demoted to the hung-box backstop it should be.
Unbuilt; the cap is the placeholder.

### The build pipeline

Provisioning and updating a box is staged, and each stage is keyed by a
content hash of its declared inputs. A stage runs only when its hash
changes; a changed stage invalidates every stage after it. The chain is
linear and short:

1. Environment image — OS, node, supabase CLI, Postgres, browsers.
   Watches tool-version declarations; cached as a provider snapshot (or a
   registry image) whose id lives in `stage_cache` under the hash, and
   self-built from a stock base image on a cache miss.
2. Dependencies — `pnpm install` on top of 1. Watches the lockfile.
3. Database state — migrate + seed. Watches the `supabase/` directory.
4. Build and static analysis — typegen, build, typecheck, lint, bundle
   metrics. Watches source (and sits after 3 because the schema generates
   types the build and linters consume).
5. Deploy to the box's test port.
6. Scene executions. Switching actors or teams enters here, below every
   analysis stage, which is why a re-run-as-team-Y never re-lints.

Hashes are computed in the worker at webhook time, before any box exists:
git is already a content-addressed store, and the GitHub API returns the
tree hash of any path at any commit without a clone. A stage's key is
hash(parent stage hash, watched tree hashes, stage config) — the parent
hash gives the invalidation cascade, and hashing the config means editing
the pipeline itself busts the cache. Keys are content hashes rather than
commit SHAs, so a rebase invalidates nothing and a merge to main reuses the
merged PR's artifacts. A docs-only push changes no stage hash and does
nothing at all.

The cache table is global — `(stage, input_hash)` — not per-PR, which is
what lets one PR reuse work another PR (or a past merge) already did. Two
kinds of stages sit behind it:

- Artifact stages (image, deps, build): a cache hit fetches the artifact.
- State stages (db reset, deploy): there is nothing to fetch; a hit means
  the box already embodies that state. The box carries the vector of stage
  hashes it has realized; on each push the PR object diffs the desired
  vector against the realized one and runs from the first divergence.

When a push rebuilds the box, in-flight runs on the old state are cancelled
immediately — latest wins. The only state worth a verdict is the one that
might merge, and a late completion report from the old box cannot overwrite
the cancellation.

Static-analysis reports — lint and typecheck deltas, bundle sizes,
dependency changes — are stage outputs keyed the same way, stored in the
overview tables. The PR comparison view is "report at base hash vs report
at head hash," and identical inputs share one report across runs and across
PRs.

The pipeline definition (stage commands and watch globs) lives in the
user's repo, in their scenetest folder, because it must change atomically
with the code it builds; it is hashed like any other input. The cloud UI
gets only operational verbs — full db reset, re-seed, force-rebuild from
stage N — which travel the normal command path and are never configuration.
The split rule: anything that affects artifact content lives in the repo;
anything operational lives in the UI. If UI config could alter build
content, the same tree would build differently on different days and the
content-addressing would rot. This file is the second user-facing contract
after the wire protocol, and gets the same versioning care: a version
field, coarse defaults when absent (over-rebuilding is slow; under-
rebuilding is wrong).

Why not Bazel, Nix, or Turborepo: those systems model hermetic builds —
pure functions from inputs to artifacts. Half this pipeline is deliberately
not that ("reset the running database," "this box now embodies state X"),
and a state stage's cache hit — skip, because this particular live machine
is already there — has no equivalent in an artifact cache. They also can't
decide anything at webhook time (each needs a checkout and its own runtime;
the decision here happens in the worker from tree hashes alone), and each
would demand adoption inside users' repos, which is the setup cost
scenetest exists to avoid. The ideas they pioneered — content addressing,
invalidation cascades, config-as-input — are the part this design borrows,
and that part is small. The boundary: these stages orchestrate machine
readiness, and whatever build tool the user's repo already uses runs inside
a stage command. If the repo has fine-grained caching of its own, the two
compose — the stage hash decides whether to invoke it at all.

### Scene isolation

Every scene has setup and cleanup functions, and they are the isolation
mechanism — not environment rebuilds between scenes. Data left behind by a
cleanup that doesn't clean is a real bug in the app's data lifecycle, and
the framework's job is to surface it, not paper over it: an optional
post-cleanup check (row counts or a table checksum against pre-setup state)
turns "scene 31 is mysteriously flaky" into "scene 12 leaks rows."

Two consequences, accepted: concurrent scenes on one database are safe only
when their data is disjoint, which is the setup engineer's assertion to
make (actors and teams often partition naturally, but we don't guarantee
it); and the full-reset bailout stays available for mid-development
weirdness.

### Auth

Three surfaces:

1. Humans: GitHub OAuth, implemented in this repo (stateless HMAC-signed
   session cookies, an `allowed_user` allowlist, first-login bootstrap via
   `BOOTSTRAP_ALLOWED_LOGIN`). The original plan here was Cloudflare Access
   for the solo phase and a library (`better-auth`) for multi-user; the
   hand-rolled flow shipped first, keeps the part of the principle that
   matters — OAuth-only, no passwords stored, sessions are signed not
   stored — and is covered by crypto unit tests, so it stays. A library
   becomes worth revisiting if auth grows surface (orgs, multiple
   providers).
2. Runner box and CLI: a bearer token minted when the box is provisioned,
   scoped to that box and dead when the box is destroyed; the PR's Durable
   Object validates it on the WebSocket handshake. Scoped API keys for CI
   follow the same pattern.
3. GitHub webhooks: HMAC signature verification with the webhook secret.

## Event flow: assertion result to watcher's screen

The cloud path, end to end. Steps 1–3 are identical on a laptop in dev mode.

```
 runner box (DigitalOcean)                Cloudflare                viewer
┌─────────────────────────────┐      ┌──────────────────┐      ┌────────────┐
│ Playwright-driven browser   │      │                  │      │ dashboard  │
│   └─ injected listener ──┐  │      │  Worker (Hono)   │      │ widget     │
│ CLI / Playwright events ─┤  │  WS  │    └─ PR DO ─────┼──WS──┼─ transport │
│   agent local relay ◄────┘  ├──────┼──►  • fan-out    │      │  adapter   │
│     ├─ .jsonl sink          │      │     • cmd queue  │      └────────────┘
│     └─ upstream sink ───────┘      │     • (Queue→D1)*│
│                                    │  end of run:     │
│                                    │  .jsonl → R2     │
└────────────────────────────────────┴──────────────────┘
```

(* the optional Queue leg is designed, not yet built. The R2 artifact upload
is built: the worker assembles each run's events from D1 into a `.jsonl`
object at completion, and a cron sweep prunes the D1 rows once the artifact
exists — see the R2 bullet above.)

1. In the Playwright-driven browser on the box, a `should()` check in the
   app under test resolves. The injected listener captures it and POSTs it
   same-origin to the box-local dev server.
2. The agent's local relay (the box-side counterpart of the receiver —
   see "Receiver core" above) accepts it as a protocol event. CLI events —
   Playwright actions, "can't click this element" — enter at the same
   point, streamed by the scenes CLI via `SCENETEST_REPORT_URL`.
3. The event goes to both sinks: appended to the local `.jsonl`, and handed
   to the upstream sink, which sends it over the box's authenticated
   outbound WebSocket.
4. The worker routes the socket to the PR's Durable Object
   (`idFromName('owner/name#42')`).
5. The Durable Object validates the box token, updates live run state,
   pushes the event to every connected viewer socket, and optionally
   enqueues a metadata update for D1.
6. The viewer's transport adapter receives the protocol event, the dashboard
   store updates, and Preact paints the new assertion row.

In dev mode the trace collapses: listener → same-origin middleware →
receiver core → `.jsonl` sink + in-process broadcast (SSE) → the dashboard
at `/__scenetest`. Same events, same widget, same receiver, minus the
Cloudflare hops.

Commands flow the reverse path: viewer clicks "re-run as a different team" →
transport adapter → worker → PR object's command queue → down the box's
WebSocket → CLI executes → resulting events flow back up as above. Because
the box is warm and actor changes sit below every build stage, that command
is a batch of one execution, not a provisioning cycle.

## The home view

The daily-work dashboard: every project's open PRs, live run status
("60% done, 1 failing, 1 flaky"), a notification when a job finishes. It is
a projection of events the system already has, at a coarser granularity.

- Alongside fine-grained assertion events, the protocol defines a run-status
  family: `run.started`, `run.progress {pct, failing, flaky}`,
  `run.finished {score}`. Each PR object computes rollups for its active
  runs from the events it already sees and emits status events upward,
  throttled (on change, at most every ~2s). Raw assertion events never fan
  out beyond the PR's own viewers.
- A per-workspace object sits above the PR objects. It receives status
  events via object-to-object calls, holds the live "all my PRs and their
  runs" snapshot, and serves the home dashboard's WebSocket with the same
  hibernation fan-out pattern.
- Notifications are sent by the workspace object because they must fire with
  no tab open. On `run.finished` it sends a Web Push; subscriptions are
  stored in D1.
- The PR list comes from GitHub webhooks rather than runs: PR
  opened/closed/merged → HMAC-verified worker handler → upsert into D1 →
  poke the workspace object.
- The home view loads as snapshot plus deltas: initial render from D1 (open
  PRs, last-known statuses — still metadata, so the D1 rule holds), then a
  subscription to the workspace object for live updates.
- The home view is cloud-only code in this repo; it has no dev-mode
  counterpart. It is a shell built around the shared widget: tiles consume
  protocol status events, and clicking a run mounts the same
  `mountDashboard()`. If the shell ever needs the widget's internals rather
  than the protocol and URLs, the boundary is being broken.

Trace for one tile: assertion events → PR object rollup → throttled
`run.progress` → workspace object → one WebSocket frame → tile updates. On
finish: same path, plus a D1 snapshot write and a push notification.

## Visual style

Visual language follows code ownership. Pixels painted by monorepo code use
the terminal style; pixels painted by cloud code use the documentation
site's aesthetic. No surface mixes the two.

The composition follows a familiar pattern: docs sites already embed
terminal output as framed code blocks, and the cloud shell treats the
mounted dashboard the same way — a docs-styled page in which the live run is
an embedded terminal pane, framed deliberately. The seam is a design
element, not something to blend away.

How this holds in practice:

- `mountDashboard()` renders into a shadow root with its own styles and
  fonts. The dev overlay needs this anyway (it injects into arbitrary user
  apps); the cloud shell inherits the same isolation. Styles cannot leak in
  either direction.
- The widget's only theming surface is a small set of CSS custom properties
  (`--st-bg`, `--st-accent`, font size, a terminal color scheme) — the scope
  of a terminal emulator's settings. The shell may set these; it cannot
  reach internals. They are versioned with the widget, like the wire
  protocol.
- The docs aesthetic is copied, not shared: the shell copies the docs site's
  tokens (type scale, palette, spacing) into a stylesheet in this repo. This
  is visual similarity, not runtime reliability — drift costs a stylesheet
  tweak, so it doesn't warrant a package or a sync mechanism.

One consequence: home-view tiles show run data but are painted by cloud
code, so they use the docs language — text in a document, not
mini-terminals. The terminal aesthetic appears only where the widget mounts.

## Order of work

1. The protocol package — the event and command vocabulary. This is the one
   decision that is expensive to change later.
2. Refactor the dev tool against it: extract the receiver core and the
   dashboard widget. Dev behavior should be observably unchanged; that is
   the proof the abstraction is right.
3. Build the cloud service around it: worker, Durable Objects, D1/R2, runner
   provisioning, with cloud-only features built around the mounted dashboard
   via the protocol and URLs, never by reaching into its internals.
