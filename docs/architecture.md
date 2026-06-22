# Scenetest Cloud — Architecture

Scenetest runs end-to-end tests with inline assertions: a Vite plugin injects
a listener into the app under test, a CLI drives Playwright sessions, and a
dashboard shows assertion results live. This document describes how the dev
tool and the cloud service share one architecture.

> **Status.** This describes the *intended* architecture. Where the running
> code differs from the target — chiefly the box's hand-rolled agent converging
> on the shared **receiver**, and the cloud reusing that same relay element —
> the text marks it **(transitional)**.

## The system, top to bottom

![Scenetest Architecture Diagram](./scenetest-cloud-architecture-3-layers.png)

GitHub is the one git host we support. It sends webhooks to the **Worker** —
the main app — which authenticates them, records the PR, and spins up that
PR's coordinator. Alongside the Worker runs a singleton **Home Coordinator**
Durable Object: it holds the realtime WebSocket connections to the web
interface and pushes live updates about running tests, reading settled state
from a **D1** database. The Worker, the Home Coordinator, and D1 together are
the permanent, cross-PR top of the system — the part that outlives any one run.

One level down is everything that happens inside a single PR. The web UI mounts
the **dashboard widget**, which embeds the entire dev experience in the cloud
service, and takes realtime updates from that PR's own **PR Coordinator**
Durable Object. The PR Coordinator owns a **SQLite** log of every event the PR
has produced — the source of truth — and manages its own **R2** archives at run
boundaries. It receives those events from below, up the wire from the test
sandbox.

The sandbox is managed entirely by the `scenetest-js` repo, and mirrors almost
exactly what runs on a developer's own machine. It is a short-lived VPS with a
**single** outbound WebSocket back to the PR Coordinator — its only connection
to the outside world. That one socket carries traffic both ways: events travel
up it, and signals come down it — refresh the checkout and reinstall
dependencies, start or stop a run, and so on.

That bridge — the cloud-embedded dashboard talking to the PR Coordinator — is
conceptually the same as the bridge a developer already has locally: their
**dev dashboard** talking to the **Vite plugin**, which uses the **CLI** to
drive the headless Playwright browsers that power the end-to-end tests. The two
deployments are the same shape; only the middle hop differs.

Commands from either dashboard — cloud or local — terminate at the CLI, which
drives the browser. The CLI returns pass/fail and other results onto the event
log, back to the Vite middleware (the **receiver**), and from there either up to
the cloud or simply into the local logs that accrete in your `scenetest/.reports`
directory. Assertion pass/fail signals arrive from the browser through that same
receiver endpoint, and an injected **listener** watches for console errors and
the like. Both kinds of information — driver results and in-page assertions —
join one event stream and flow outward and upward, outward and upward, until
they settle into aggregates in D1, served either by the Worker at the top or by
its Durable Object for realtime.

## Repository layout

Code is grouped by release channel and deploy cadence rather than by topic.

| Repo | Contents | Ships as | Cadence |
|---|---|---|---|
| `scenetest/scenetest-js` | Vite plugin, CLI (`scenes`), `checks` + framework bindings, `protocol`, `dashboard`, receiver | npm packages, run inside users' projects | Versioned releases; users sit on old versions indefinitely |
| `scenetest/scenetest-cloud` (this repo) | Worker, Durable Object classes, D1 schema/migrations, runner-box provisioning | Deployed by us to our Cloudflare account | Continuous deploy; one live version |

The seam between the two repos is a published package and a wire protocol. A
service deploy and an npm release should never need to be atomic; if they do,
the protocol versioning has failed.

## The protocol package

`@scenetest/protocol` is a small versioned package defining the typed event and
command vocabulary plus serialization. Every part of the system produces or
consumes this vocabulary — the injected listener and the CLI produce events, the
human produces commands, the dashboard and the log consume them — and everything
below is an implementation behind it, swappable without changing it.

It is its own package, and the only thing the cloud Worker depends on from the
monorepo, because:

1. Most of its consumers (CLI, plugin, dashboard) live in the monorepo.
2. The open-source tool has to work without the cloud existing, so the
   dependency arrow points from cloud to toolkit and never the reverse.
3. Users run last month's CLI against today's worker. Routing wire-format
   changes through a published release keeps version skew visible.

## The receiver and the transport

The two ends of the wire. The **protocol** is the contract both speak; the
**receiver** (server) and the **transport** (client) are duals that move it.

### The receiver (the relay)

`@scenetest/receiver` is the server-side half of the pipeline: it accepts
protocol events, assigns the layer's order, and emits to sinks (a durable log, a
live stream, the next relay up). It is the **relay**, and the same element
appears at every layer that carries events upward. Dev runs it as Vite
middleware (`/__scenetest`).

**(Transitional — target state.)** The cloud's earlier plan was that it would
*not* run the receiver: the box hand-rolled the relay in a small agent, and the
PR object hand-rolled its own. The direction now is the opposite — one relay
element, reused. The box runs the receiver package (retiring the agent), and the
PR Durable Object is the same relay one layer up, differing only in its ordering
log (SQLite vs the box's `.jsonl`) and its counter (`id` vs `seq`). The ordering
log is special: it is the first sink, because appending to it is what *assigns*
the order the other sinks and the up-relay carry. What every layer shares is the
**wire contract** (the protocol and its envelope-grade relay rule); version
normalization, when it's needed, belongs at the relay — with the Durable Object
the most-deployable place to keep it current.

### The dashboard widget

The Preact dashboard is a component the host mounts into its light DOM,
parameterized by a transport adapter. It renders the same UI in dev and cloud;
only the adapter differs.

### The transport adapter

The injection point where dev and cloud differ, and the **client dual of the
receiver**: where the receiver orders-and-emits on the server, the transport
subscribes-and-reduces on the client. The widget calls it to subscribe to the
ordered stream and to send commands; it speaks to whatever backend is present —
Vite middleware (SSE) in dev, the worker API (WebSocket) in cloud. Because the
dev/cloud difference is confined to this object, the dashboard behaves the same
in both by construction. The subscription replays the ordered stream from a
cursor on connect, then delivers live deltas through the same channel — history
and live fold the same way, with no separate snapshot fetch.

## The log and its projections

Two storage categories, and nothing is allowed to blur them.

**The log** is every event, append-only, ordered. It is the one source of
truth — the protocol message stream itself. Assertion results, Playwright
actions, driver failures, the human's commands: all of it is one ordered stream
of opaque messages.

**Projections** are everything derived from the log: a scene's current status, a
run's score, the home view's toplines, the overview comparison deltas. A
projection is a pure function of the log. Persisting one is always and only a
performance or queryability move — never a new fact, always rebuildable by
replaying the log. This is the rule that keeps the two halves honest: if a
stored value cannot be regenerated from the log, it is either part of the log or
a bug.

`run_id` is a field on each message, not a container. Because runs align with
the order axis, a run is derivable from the log as the messages between two
positions — so a run is a denormalized convenience for the UI (chunking a load,
drawing a timeline, jumping between runs), never a structural boundary. Anything
that splits *by* run — a per-run R2 file, a run filter on a query — does so for
ergonomics on top of an order the log already provides.

One read primitive serves the log to every consumer: a cursor-based fetch of
ordered messages — `read(cursor)` yielding messages in order. `run_id` and `ts`
are ordinary fields, none privileged; the reader takes the whole stream and any
slicing is the client's. The live dashboard, the replay-on-connect, and the
archived-PR read all go through this one door. Whether the bytes come from a live
store or a durable archive is hidden behind it; the consumer sees one ordered
stream.

**The DO owns the log.** In the cloud, the box asserts a *fact* — `(seq,
payload)`, its per-run sequence — and the PR object records it, minting a
PR-global `id` in the order it received the fact. `seq` is the fact's; `id` is
the *log's*: the canonical record of receive-order, not of when things happened.
So a PR subscriber tails the log, not the fact-stream — it sees events in the
order the DO logged them (frozen once minted), which need not be the order they
occurred (a slow box, a reconnect resend, overlapping runs). That is the point:
one authoritative receive-order, owned by one object, deterministic and
replayable, so distributed real-time ordering across boxes never has to be
reasoned about. The PR-anchored stream orders and resumes on `id`; the per-run
view still orders on `seq`, which doubles as the resend-idempotency key
(`UNIQUE(run_id, seq)`) — so a single `seq` authority per run is required, which
is why the box's emitters funnel through one relay. Because the cross-run
interleaving the `id` captures cannot be reconstructed from per-run facts and
timestamps, the R2 archive carries `id` (and `ts`) per line. On revival, an
archived run is folded back under its *original* `id`, so the stream replays
identically no matter what order runs are restored in.

Where the two categories live, across both environments. The first row is not
just dev: it is also the per-PR runner box — the production machine a user's app
is spun up and tested on, running the same code path as a laptop.

| | the log | projections |
|---|---|---|
| dev / runner box | local `.jsonl` | derived in the client collection, not persisted |
| cloud, live | DO SQLite log table | DO SQLite aggregate (a cache) + D1 settled |
| cloud, durable | R2 `.jsonl`, per-run files | D1, forever |

The log is one content in three homes — the box's `.jsonl`, the PR object's
SQLite, the R2 archive — differing only in durability and locality. Projections
appear in both environments, but dev derives them in memory and throws them away
(re-deriving from the single `.jsonl` is free in one ephemeral session), while
the cloud persists them, because its projections answer cross-PR queries and must
outlive the PR object that computed them. That persistence is the performance
move; it adds no truth the log does not already hold.

The one thing in neither category is **command delivery state**. A command is in
the log like any other message, but its delivery (pending → sent to the box) is
control-plane state that mutates and is not derivable from observations. It rides
alongside the append-only log; it is not part of the pure-function story.

## Dev mode

The Vite plugin is a thin, same-origin adapter: it injects the listener, mounts
the receiver as middleware, serves the dashboard at `/__scenetest`, and uses an
append-to-`.jsonl` sink. Same-origin matters — no CORS, no extra port, works in
Codespaces and devcontainers.

## Cloud service (this repo)

Units of work, smallest to largest: a scene execution is the atomic unit and is
parameterized (the same scene with a different team is a different execution); a
run is a batch of executions triggered together and owns no infrastructure; a box
is the environment a PR's executions run in; the PR is the unit of coordination,
because a PR getting merged is the goal the whole system serves. These are units
of *work and coordination*, not of storage — in the log a run is a field on each
message, not a container.

Each Cloudflare primitive has one job:

- **The Worker** handles API routes and auth, serves the dashboard shell and
  static assets, and routes run traffic to Durable Objects.
- **One Durable Object per PR** is the coordination point. It owns the box's
  lifecycle (when to provision, what a push requires, when to tear down),
  terminates the box's outbound WebSocket on one side, fans out to dashboard
  viewers on the other (hibernation API), and holds the pending command queue. It
  also **owns the PR's event log** in its own SQLite; the live fan-out and
  replay-on-connect read from there, and a derived live aggregate may sit beside
  it, droppable and rebuildable from the log.
- **D1** holds only **settled projections** — enough to render lists and the
  cross-PR home view, none of it a fact the log does not already hold. It is never
  an event sink: log lines live in the PR object's SQLite and the R2 archive,
  never in D1. The object writes these projections at run boundaries — a couple of
  writes per run, not per event.
- **R2** holds the durable record: when a run completes the object flushes that
  run's log to a per-run `.jsonl`. A finished run is immutable, so archiving at
  completion is both simpler and more durable — it survives even if the object is
  later evicted, and a closed PR's detail view reads these objects directly
  through the worker with nothing to spin up. The cron sweep is only a backstop
  that archives any terminal-but-unflushed run; it prunes nothing, because D1
  never held the log.

### Runner

One ephemeral box per PR — not per run. The box runs the same code path as a
developer's laptop: app under test, database, seeds, Playwright, the scenes CLI,
the receiver — all local to the box, so scene executions stay atomic. A re-run
against a warm box costs seconds, not a provisioning cycle.

Configuration is the only difference from dev mode: the box's sink writes the
local `.jsonl` and also streams events up the box's single outbound WebSocket to
the PR's Durable Object. Outbound-only means no inbound firewall holes; commands
ride the same socket back down.

Teardown is idle-based and owned by the PR object: a Durable Object alarm is
re-armed on every activity signal and, when it fires after the PR's runs have all
settled, the box is retired. An in-flight run re-arms rather than retiring. A
wall-clock age cap stays only as the hung-box backstop, for boxes the alarm never
retired.

### The runner is a swappable substrate

The runner is not coupled to DigitalOcean. `Runner` is `provision()` +
`dispatch()`, selected by `RUNNER_PROVIDER`, so the machine a box runs on swaps
without touching the coordinator, the log, D1/R2, or the stage cache. The user
contract is the same on every substrate: **bake an image, then run setup
scripts.**

DigitalOcean is the first substrate because it is the most *flexible*: a stock VM
faithfully recreates any dev box, including Docker-based local stacks. Other
substrates (Cloudflare Containers the natural second) join behind the same
interface, trading flexibility for speed or simplicity. The one constraint every
substrate honors is the build model — the stage cache's *state* stages mutate a
live, warm box, so a container runs that same staged build inside itself rather
than baking the whole box into one immutable image.

### The build pipeline

Provisioning and updating a box is staged, and each stage is keyed by a content
hash of its declared inputs. A stage runs only when its hash changes; a changed
stage invalidates every stage after it. Two kinds of stage sit behind a **global**
cache table keyed `(stage, input_hash)` — global, so one PR reuses work another PR
(or a past merge) already did:

- **Artifact stages** (image, deps, build): a cache hit fetches the artifact.
- **State stages** (db reset, deploy): nothing to fetch; a hit means the box
  already embodies that state. The box carries the vector of stage hashes it has
  realized, and on each push the PR object diffs desired against realized and runs
  from the first divergence.

Hashes are computed in the worker at webhook time, before any box exists: git is
already content-addressed, and the GitHub API returns the tree hash of any path at
any commit without a clone. Keys are content hashes rather than commit SHAs, so a
rebase invalidates nothing, a merge to main reuses the merged PR's artifacts, and
a docs-only push does nothing. When a push rebuilds the box, in-flight runs on the
old state are cancelled immediately — latest wins; the only state worth a verdict
is the one that might merge.

The pipeline definition (stage commands and watch globs) lives in the user's repo,
because it must change atomically with the code it builds, and is hashed like any
other input. The cloud UI gets only operational verbs (full reset, re-seed,
force-rebuild from stage N), which travel the command path and are never
configuration. The split rule: anything that affects artifact content lives in the
repo; anything operational lives in the UI — otherwise the same tree would build
differently on different days and the content-addressing would rot.

### Auth

Three surfaces:

1. **Humans:** GitHub OAuth, stateless HMAC-signed session cookies, an
   `allowed_user` allowlist. The viewer/home WebSocket routes also accept the
   session token via `?session=` for header-less test clients, but a bearer in a
   URL is loggable where a cookie isn't (CWE-598), so that fallback is gated to
   dev/test and refused in cloud.
2. **Runner box and CLI:** a bearer token minted when the box is provisioned,
   scoped to that box and dead when it is destroyed; the PR's Durable Object
   validates it on the WebSocket handshake.
3. **GitHub webhooks:** HMAC signature verification with the webhook secret.

## Event flow: assertion result to watcher's screen

The cloud path, end to end. Steps 1–3 are identical on a laptop in dev mode.

```
 runner box                               Cloudflare                viewer
┌─────────────────────────────┐      ┌──────────────────┐      ┌────────────┐
│ Playwright-driven browser   │      │                  │      │ dashboard  │
│   └─ injected listener ──┐  │      │  Worker (Hono)   │      │ widget     │
│ CLI / Playwright events ─┤  │  WS  │    └─ PR DO ─────┼──WS──┼─ transport │
│   receiver (relay)* ◄────┘  ├──────┼──►  • SQLite log │      │  adapter   │
│     ├─ .jsonl sink          │      │     • fan-out    │      └────────────┘
│     └─ upstream sink ───────┘      │     • cmd queue  │
│                                    │  projections→D1  │
│                                    │  log→R2 @ done   │
└────────────────────────────────────┴──────────────────┘
```

1. In the Playwright-driven browser on the box, a `should()` check resolves. The
   injected listener captures it and POSTs it same-origin to the box-local
   receiver.
2. The box-side **receiver** *(transitional: today a hand-rolled agent;
   converging on the receiver package)* accepts it as a protocol event. CLI
   events — Playwright actions, "can't click this element" — enter at the same
   point via `SCENETEST_REPORT_URL`.
3. The event goes to both sinks: appended to the local `.jsonl`, and handed to the
   upstream sink, which sends it over the box's authenticated outbound WebSocket.
4. The worker routes the socket to the PR's Durable Object.
5. The Durable Object validates the box token, appends the event to its SQLite log
   (the source of truth), updates the live aggregate, and pushes the event to
   every connected viewer socket. Settled projections go to D1 at run boundaries.
6. The viewer's transport adapter receives the event, the dashboard store updates,
   and Preact paints the new assertion row.

In dev mode the trace collapses: listener → same-origin middleware → receiver →
`.jsonl` sink + in-process broadcast (SSE) → the dashboard. Same events, same
widget, same receiver, minus the Cloudflare hops.

Commands flow the reverse path: viewer → transport adapter → worker → PR object's
command queue → down the box's WebSocket → the receiver forwards to the CLI →
resulting events flow back up. *(Transitional: the box acting on commands — the
inbound command channel that drives the CLI — is the open piece converging with
the receiver-on-box work.)*

## The home view

Every project's open PRs, with live run status and a coarse rollup. It is a
projection of events the system already has, at a coarser granularity.

Alongside fine-grained assertion events, the protocol defines a run-status family
(`run.started`, `run.progress {pct, failing}`, `run.finished {score}`). Each PR
object computes these rollups from the events it already sees and pushes them **up
to a singleton `HomeCoordinator` Durable Object by direct object-to-object call** —
one-way and sparse, never a socket. **Only this rollup crosses up; raw assertion
events never leave the PR's own viewers** — the home tier sees aggregates, not the
stream. The worker can't be that rendezvous (stateless, per-request); the DO is the
connection-holding primitive, the same reason `PrCoordinator` exists, one level up.

`HomeCoordinator` owns no canonical state: it holds a last-write-wins tile cache
rebuilt from the D1 projections on cold start, and fans deltas out to the home
dashboard's WebSocket subscribers. The PR list itself comes from GitHub webhooks
(opened/closed/merged → HMAC-verified handler → upsert into D1 → poke the
`HomeCoordinator`). The home view paints from the D1 snapshot and overlays live
tiles from the subscription. It is cloud-only code in this repo; it has no
dev-mode counterpart.
