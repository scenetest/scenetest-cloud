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

A framework-agnostic Hono app that accepts protocol events and hands them to
a pluggable sink. Because a Hono app is just a `fetch` handler, the same
routes and handlers run in both environments: mounted into Vite's connect
server in dev (via the node adapter), and natively on the Worker and inside
Durable Objects in cloud. Hono's RPC client (`hono/client`) gives the
transport adapter end-to-end types on top of the protocol types.

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

## Dev mode

The Vite plugin is a thin, same-origin adapter: it injects the listener,
mounts the receiver core as middleware, serves the dashboard at
`/__scenetest`, and uses an append-to-`.jsonl` sink. Same-origin matters
here — no CORS, no extra port, works in Codespaces and devcontainers — so
the middleware stays; it is a small wrapper over the shared core.

## Cloud service (this repo)

Each Cloudflare primitive has one job:

- The worker (Hono) handles API routes and auth, serves the dashboard shell
  and static assets, and routes run traffic to Durable Objects. The shell is
  Preact, same as the widget. React-flavored libraries (e.g. TanStack Query)
  are consumed through the standard `preact/compat` alias; `react` and
  `react-dom` never enter the dependency tree.
- One Durable Object per run is the live coordination point. It accepts the
  runner box's outbound WebSocket on one side, fans out to dashboard viewers
  on the other (WebSocket hibernation API), and holds the pending command
  queue. A per-PR object can aggregate run objects above this if needed.
- D1 holds metadata only — runs, scores, failures; enough to render lists
  and link into R2 — and never log lines. D1 caps at 10 GB, so append-heavy
  event logs are kept out of it by design rather than as a later
  optimization.
- R2 holds the durable record. The runner box's complete `.jsonl` is
  uploaded at end of run and becomes the source of truth for raw events;
  historical detail views read it through the worker. The local file is not
  a backup of the database — uploading it is the persistence step.
- Queues (optional) decouple Durable Object write-through from D1 metadata
  updates and absorb webhook bursts. They are not on the live path.

### Runner

An ephemeral DigitalOcean box that runs the same code path as a developer's
laptop: app under test, database, seeds, Playwright, CLI, receiver core —
all local to the box, so test runs stay atomic. Configuration is the only
difference: the box's sink writes the local `.jsonl` (debug + artifact) and
also streams events up the box's single outbound WebSocket to the run's
Durable Object. Outbound-only means no inbound firewall holes; commands ride
the same socket back down.

### Auth

Three surfaces:

1. Humans: Cloudflare Access in front of the worker for the solo phase (no
   auth code). GitHub OAuth via a library (e.g. `better-auth` on Workers/D1)
   when multi-user. OAuth-only; no passwords stored.
2. Runner box and CLI: a short-lived, single-run bearer token minted at
   provisioning time; the run's Durable Object validates it on the WebSocket
   handshake. Scoped API keys for CI follow the same pattern.
3. GitHub webhooks: HMAC signature verification with the webhook secret.

## Event flow: assertion result to watcher's screen

The cloud path, end to end. Steps 1–3 are identical on a laptop in dev mode.

```
 runner box (DigitalOcean)                Cloudflare                viewer
┌─────────────────────────────┐      ┌──────────────────┐      ┌────────────┐
│ Playwright-driven browser   │      │                  │      │ dashboard  │
│   └─ injected listener ──┐  │      │  Worker (Hono)   │      │ widget     │
│ CLI / Playwright events ─┤  │  WS  │    └─ run DO ────┼──WS──┼─ transport │
│   receiver core (Hono) ◄─┘  ├──────┼──►  • fan-out    │      │  adapter   │
│     ├─ .jsonl sink          │      │     • cmd queue  │      └────────────┘
│     └─ upstream sink ───────┘      │     • (Queue→D1) │
│                                    │  end of run:     │
│                                    │  .jsonl → R2     │
└────────────────────────────────────┴──────────────────┘
```

1. In the Playwright-driven browser on the box, a `should()` check in the
   app under test resolves. The injected listener captures it and POSTs it
   same-origin to the box-local dev server.
2. The receiver core validates it into a protocol event. CLI events —
   Playwright actions, "can't click this element" — enter at the same point,
   directly from the CLI process.
3. The event goes to both sinks: appended to the local `.jsonl`, and handed
   to the upstream sink, which sends it over the box's authenticated
   outbound WebSocket.
4. The worker routes the socket to the run's Durable Object
   (`idFromName(runId)`).
5. The Durable Object validates the run token, updates live run state,
   pushes the event to every connected viewer socket, and optionally
   enqueues a metadata update for D1.
6. The viewer's transport adapter receives the protocol event, the dashboard
   store updates, and Preact paints the new assertion row.

In dev mode the trace collapses: listener → same-origin middleware →
receiver core → `.jsonl` sink + in-process broadcast (SSE) → the dashboard
at `/__scenetest`. Same events, same widget, same receiver, minus the
Cloudflare hops.

Commands flow the reverse path: viewer clicks "re-run as a different team" →
transport adapter → worker → run object's command queue → down the runner's
WebSocket → CLI executes → resulting events flow back up as above.

## The home view

The daily-work dashboard: every project's open PRs, live run status
("60% done, 1 failing, 1 flaky"), a notification when a job finishes. It is
a projection of events the system already has, at a coarser granularity.

- Alongside fine-grained assertion events, the protocol defines a run-status
  family: `run.started`, `run.progress {pct, failing, flaky}`,
  `run.finished {score}`. Each run object computes its own rollup from the
  events it already sees and emits status events upward, throttled (on
  change, at most every ~2s). Raw assertion events never fan out beyond the
  run's own viewers.
- A per-workspace object sits above the run objects. It receives status
  events via object-to-object calls, holds the live "all my PRs and their
  runs" snapshot, and serves the home dashboard's WebSocket with the same
  hibernation fan-out pattern. (A per-PR object goes between them only if a
  single PR ever carries enough concurrent runs to need its own rollup.)
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

Trace for one tile: assertion events → run object rollup → throttled
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
