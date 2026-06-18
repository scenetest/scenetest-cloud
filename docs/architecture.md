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
- Consumers: the dashboard (live view), the recorder of the log (`.jsonl` in
  dev; the PR object's SQLite live, flushed to R2 at teardown, in cloud), the
  CLI (its instruction queue). Projections (scores, toplines) are derived from
  the log, not separately recorded — in dev the client derives them in memory,
  in cloud D1 holds the settled ones. See "The log and its projections."

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
behaves the same in both by construction. Both adapters implement one shape —
a snapshot fetch plus a live subscription — which is the read primitive of
"The log and its projections" seen from the client: a cursor read of the
ordered stream, then deltas.

## The log and its projections

Two storage categories, and nothing is allowed to blur them.

**The log** is every event, append-only, ordered by `seq`. It is the one
source of truth — the protocol message stream itself, the same vocabulary the
protocol package defines. Assertion results, Playwright actions, driver
failures, the human's commands: all of it is one ordered stream of opaque
messages.

**Projections** are everything derived from the log: a scene's current status,
a run's score, the home view's toplines, the overview comparison deltas. A
projection is a pure function of the log. Persisting one is always and only a
performance or queryability move — never a new fact, always rebuildable by
replaying the log. This is the rule that keeps the two halves honest: if a
stored value cannot be regenerated from the log, it is either part of the log
or a bug.

`run_id` is a field on each message, not a container. Because runs align with
`seq`, a run is derivable from the log as the messages between two sequence
numbers — so a run is a denormalized convenience for the UI (chunking a load,
drawing a timeline, jumping between runs), never a structural boundary. `seq`
is the authoritative axis: monotonic, fine-grained, total. Anything that
splits *by* run — a per-run R2 file, a run filter on a query — does so for
ergonomics on top of an order `seq` already provides.

One read primitive serves the log to every consumer: a cursor-based fetch of
ordered messages — `read(cursor)` yielding messages in `seq` order. `run_id`
and `ts` are ordinary fields on each message, none privileged; the reader
takes the whole stream and any slicing is the client's. The live dashboard,
the replay-on-connect, and the archived-PR read all go through this one door.
Whether the bytes come from a live store or a durable archive is hidden behind
it; the consumer sees one ordered stream.

Where the two categories live, across both environments. The first row is not
just dev: it is also the per-PR runner box — the production machine a user's
app is spun up and tested on, running the same code path as a laptop.

| | the log | projections |
|---|---|---|
| dev / runner box | local `.jsonl` | derived in the client collection, not persisted |
| cloud, live | DO SQLite log table | DO SQLite aggregate (a cache) + D1 settled |
| cloud, durable | R2 `.jsonl`, per-run files | D1, forever |

The log is one content in three homes — the box's `.jsonl`, the PR object's
SQLite, the R2 archive — differing only in durability and locality. The
per-run split of the R2 files is a put-time decision, invisible above the read
primitive. Projections appear in both environments, but dev derives them in
memory and throws them away (re-deriving from the single `.jsonl` is free in
one ephemeral session), while the cloud persists them, because its projections
answer cross-PR queries and must outlive the PR object that computed them. That
persistence is the performance move; it adds no truth the log does not already
hold.

The DO holding both the log and a projection is not a violation of the split:
it owns the canonical live log, and may materialize a projection table beside
it that it could drop and rebuild at any time.

The one thing in neither category is **command delivery state**. A command is
in the log like any other message, but its delivery (pending → sent to the
box) is control-plane state that mutates and is not derivable from
observations. It rides alongside the append-only log; it is not part of the
pure-function story, and the design should not pretend otherwise.

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
the whole system serves. These are units of *work and coordination*, not of
storage: in the event log a run is not a container but a field on each message
(it aligns with `seq`, so a run is just a range of the stream). See "The log
and its projections."

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
  (WebSocket hibernation API), and holds the pending command queue. It also
  **owns the PR's event log**: the box's events land in the object's own
  SQLite — keyed by `(run_id, seq)`, the order the box assigns and the viewer
  subscribes against — and both the live fan-out and replay-on-connect read
  from there, no write-through to D1. (A per-PR object-assigned cursor and a
  channel discriminator arrive with the one-collection-per-PR dashboard work;
  the storage move keeps today's per-run wire contract.)
  The log is the source of truth; the object may keep a derived live aggregate
  beside it for the dashboard, droppable and rebuildable from the log.
- D1 holds only **settled projections** — runs, scores, failures, the overview
  comparison tables; enough to render lists and the cross-PR home view, none of
  it a fact the log does not already hold. It is never an event sink: log lines
  live in the PR object's SQLite and the R2 archive, never in D1. (D1 caps at
  10 GB; keeping the append-heavy log out of it is structural, not an
  optimization.) The object writes these projections at run boundaries — a
  couple of writes per run, not per event.
- R2 holds the durable record (`ARTIFACTS` bucket): when a run completes the
  object flushes that run's log to a per-run `.jsonl` object at
  `runs/<repo>/<runId>.jsonl` and sets `runs.artifact_key`. Completion, not
  teardown: a finished run is immutable, so archiving it then is both simpler
  and more durable — it survives in R2 even if the object is later evicted.
  This is the same log the object served live — archive and live store are one
  content in two homes, and the e2e load-equivalence check pins that. A closed PR's detail
  view reads these objects through the worker: the live object is gone, so
  there is nothing to spin up — the read primitive's R2 backend serves them
  directly. Keeping these per-run rather than one PR blob makes multi-file
  consumption the norm: a PR closed and reopened spins a fresh object whose
  `id` sequence restarts, and its archive is just more run files under the
  same prefix — the reader already merges across files (run chronology across
  object lifetimes, `id` within each), so a PR that lived as several objects is
  never a special case. The cron sweep is now only a backstop that archives any
  terminal-but-unflushed run (an object evicted without clean teardown — the
  log is durable in SQLite, just not yet in R2); it prunes nothing, because D1
  never held the log. (Not R2 SQL: that queries Iceberg tables, not `.jsonl`,
  and this path is a keyed point read. R2 SQL stays the analytics axis —
  cross-run rollups, the `overview_*` tables — and if that outgrows D1 the move
  is Pipelines→Iceberg as a derived second sink, `.jsonl` staying canonical.)
- Queues (optional) decouple the object's boundary projection writes to D1 and
  absorb webhook bursts. They are not on the live path.

### Runner

One ephemeral DigitalOcean box per PR — not per run. The box runs the same
code path as a developer's laptop: app under test, database, seeds,
Playwright, the scenes CLI, the agent's local relay — all local to the box,
so scene executions stay atomic. A laptop is a persistent environment you run tests against
repeatedly; the per-PR box is the faithful analog of that, and a re-run
against a warm box costs seconds, not a provisioning cycle.

Configuration is the only difference from dev mode: the box's sink writes
the local `.jsonl` (the box-local copy of the log — debug, and the
independent witness the load-equivalence check compares against the object's
SQLite) and also streams events up the box's single outbound WebSocket to the
PR's Durable Object, which is where the durable archive is later flushed from.
Outbound-only means no inbound firewall holes; commands ride the same socket
back down.

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

### The runner is a swappable substrate

The runner is not coupled to DigitalOcean. `Runner` is `provision()` +
`dispatch()`, selected by `RUNNER_PROVIDER` (`stub`, `digitalocean`) in
`registry.ts`, so the machine a box runs on is a substrate that swaps in and
out without touching the coordinator, the event log, D1/R2, or the stage
cache. The user-facing contract is the same on every substrate: **bake an
image, then run setup scripts** (the env-image stage plus the staged build
of the pipeline). Everything above that line — coordination, the log, the
dashboard — is substrate-agnostic by construction.

DigitalOcean is the first substrate, and it is the default because it is the
most *flexible*: a stock-Ubuntu droplet can faithfully recreate any kind of
dev box. That generality matters because users will not all be on the same
stack — the box is the faithful analog of a developer's laptop (see Runner),
so it has to run whatever that laptop runs. Concretely, the baked toolchain
includes Docker, which lets the box stand up Docker-based local stacks (the
Supabase CLI's, today) exactly as a developer would. A substrate that can
run anything is the right place to start, because it never tells a user
their stack is unsupported.

Other substrates can join behind the same interface, trading flexibility for
something else. Cloudflare Containers (Firecracker microVMs fronted by a
Durable Object) are the natural second runner: less flexible than a raw VM —
no nested virtualization, so a Docker-based local stack would have to be
re-baked as a direct image (e.g. Postgres + PostgREST in the container)
rather than run under Docker, and instance memory is tighter than a droplet
— but more performant and operationally simpler for projects whose image
*does* fit. For teams working in the Cloudflare ecosystem (us included), the
payoff is real: the per-PR DO that would front a container is the PR
coordinator we already run, `sleepAfter` is exactly the idle-based teardown
the teardown note above calls the unbuilt target, and a Cloudflare-only
deployment sheds the `DO_API_TOKEN`, droplet billing, the builder-droplet
state machine, and the reaper. If you can bake a Container-compatible image,
you get the faster, cheaper substrate; if you can't, DigitalOcean runs your
box unchanged. That choice living entirely in `RUNNER_PROVIDER` is the point.

Adding a second runner is also how the swappable model earns its keep: a
single substrate can't prove the seam holds, and the abstraction is only
worth its weight if a genuinely different machine — a microVM reached by
`containerInstance.fetch()` instead of a droplet holding an *outbound*
WebSocket to its DO — slots in without disturbing anything above it. The one
thing every substrate must honor is the build model: the stage cache's
*state* stages mutate a live, warm machine ("this box now embodies state X"),
so a container either runs that same staged build inside itself or it isn't a
drop-in — baking the whole box into one immutable image would discard the
per-PR incremental cache, not implement it.

So the order of work is: ship DigitalOcean (the flexible default that
supports everyone), keep the `Runner` seam honest, then add Cloudflare
Containers as the second provider — gated on a spike that bakes a
Container-compatible image and confirms app + DB + browser fit the memory
ceiling. It is always additive; the DigitalOcean path stays for any stack
that needs a full VM.

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
│   agent local relay ◄────┘  ├──────┼──►  • SQLite log │      │  adapter   │
│     ├─ .jsonl sink          │      │     • fan-out    │      └────────────┘
│     └─ upstream sink ───────┘      │     • cmd queue  │
│                                    │  projections→D1  │
│                                    │  log→R2 @ done   │
└────────────────────────────────────┴──────────────────┘
```

(* the optional Queue leg is designed, not yet built. The PR object owns the
log in its own SQLite: it appends each event there, fans out live, writes
settled projections to D1 at run boundaries, and flushes each run's log to a
per-run `.jsonl` in R2 when the run completes — see the DO, D1, and R2 bullets
above. The cron sweep is only an archive backstop now; nothing prunes D1,
which never holds the log.)

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
5. The Durable Object validates the box token, appends the event to its
   SQLite log (the source of truth), updates the live aggregate, and pushes the
   event to every connected viewer socket. Settled projections go to D1 at run
   boundaries, not per event.
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
  `run.finished {score}`. Each PR object computes these rollups from the
  events it already sees; the settled ones land in D1 as projections, and raw
  assertion events never fan out beyond the PR's own viewers.
- The PR list comes from GitHub webhooks rather than runs: PR
  opened/closed/merged → HMAC-verified worker handler → upsert into D1.
- Past that, the home view is an ordinary web app over D1: it renders the open
  PRs and their last-known statuses from the projection tables and keeps them
  live. *How* it stays live — poll, SSE, a WebSocket, a fan-out object — is an
  implementation choice, not an architectural commitment; the load-bearing
  fact is that it reads projections, never the log. The one real constraint is
  notifications: a "job finished" push must fire with no tab open, so whatever
  triggers it lives server-side, not in the page.
- The home view is cloud-only code in this repo; it has no dev-mode
  counterpart. It is a shell built around the shared widget: tiles consume
  protocol status events, and clicking a run mounts the same widget. If the
  shell ever needs the widget's internals rather than the protocol and URLs,
  the boundary is being broken.

Trace for one tile: assertion events → PR-object rollup → D1 projection → the
home view. On finish: the same path, plus a server-side push.

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
