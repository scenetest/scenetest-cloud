# WS-shape collection — a read-only dashboard replica

Status: POC on `claude/ws-shape-collection-poc`. Destination: the **collection**
half migrates into `@scenetest/dashboard` (the widget, in scenetest-js); the
**transport** half stays per-environment. See "Where each layer belongs".

## What it is

A read-only client read model for a run. The PR's Durable Object is the
authoritative writer; the browser folds the run's event stream into typed,
queryable collections and renders them with TanStack DB live queries. One
direction only — server → client. There is no client mutation path.

## The pieces (this repo's POC)

- `lib/runShapeSource.ts` — **the transport.** One WebSocket per run, fanned out
  to N collections; resumes by `seq` (`?sinceSeq=`), dedupes the replay/live
  overlap, reconnects with backoff. The *only* part that knows about sockets.
- `lib/wsShapeCollection.ts` — `wsShapeSync({ source, project })`: a TanStack DB
  `SyncConfig` whose `project(event, rows)` reducer folds protocol events into
  row ops (`begin`/`write`/`commit`). No `onInsert/onUpdate/onDelete` handlers,
  so the sync reducer is the *sole* writer.
- `lib/collections/scenes.ts` — a concrete collection: `scene:start`/`scene:end`
  → one row per `file:name`.
- `components/ScenesPanel.tsx` — `useLiveQuery` views (a `groupBy`+`count`
  rollup, a `where` filter, an `orderBy` timeline), maintained incrementally by
  d2ts.

## The read-only contract

Synced rows land **raw** — the sync path does not validate or transform
(verified in TanStack DB's `sync.js`). A collection schema, if present, only
gates *client mutations*, which don't exist here. So validation is a read-time
/ explicit concern, never an ingest gate, and a producer-defined value is
mirrored as-is. A stray `collection.insert()` throws (no handler) — the replica
cannot be written from the client by construction.

## Where each layer belongs (and why it "feels server-y")

It is two layers, and only one of them is a server client:

- **Transport (`runShapeSource`)** — yes, this *is* a client of a server. It is
  environment-specific: in cloud it tails the PR coordinator DO's viewer channel
  (this repo); in dev the equivalent is the receiver-hosted SSE broadcast (the
  Vite plugin). This is the "transport adapter" architecture.md calls the
  dev/cloud injection point. The socket, the `seq` cursor, the reconnect — all
  live here.
- **Collection (`wsShapeSync` + concrete collections + queries)** — server-
  agnostic. It consumes `transport.subscribe(onEvent)` and knows nothing of
  sockets or `seq`. This is the widget's reactive read model and belongs in
  `@scenetest/dashboard`, shared by dev and cloud unchanged.

So the canonical factoring: **collection → the widget; transport → per
environment** (cloud here, dev in the plugin). The POC keeps both in this repo
only because it can't edit the widget package from here.

## Why it is not a receiver client

The receiver (`@scenetest/receiver`) is the **ingest** half — it accepts
producer POSTs and hands them to a sink (the write path). A "client of the
receiver" is therefore an event *uploader*: the injected listener and the CLI
reporter that POST events in. Our read model is the opposite role — a *consumer*
of the fanned-out stream (the read path). The server it actually talks to is the
DO's viewer channel (cloud) or the plugin's SSE broadcast (dev), not the
receiver. There is no single `receiver/client` for it because there is no single
read-server to be a client of: the read source is environment-specific, which is
exactly why it is a thin transport adapter rather than a package. Folding a
reactive read model into the ingest package would also point the dependency
arrow backwards (reactive client → ingest server).

## The data boundary: event-timeline vs current-state

Two kinds of data cross the viewer channel, and they want different treatment:

- **Raw event timeline** — assertions, actions, scene lifecycle. An append-only
  log where *every intermediate state matters*; the terminal widget replays it
  event by event. Its durable source of truth is the R2 `.jsonl`
  (architecture.md: "persisting it is the point"). Keep relaying it; fold it
  client-side.
- **Derived current-state** — scene status, run rollups ("running / passed /
  failed"). Only the *latest* row per key matters.

This split is the deciding factor for any off-the-shelf adoption (below): a
state-convergence engine can hold the derived current-state but throws away the
timeline.

## Relationship to `grrowl/tanstack-do-db-collection`

That library independently reaches the same core we did — single writer per DO,
a contiguous change log, **one `seq` cursor** driving deltas + reconnect +
write-confirmation (`seq >= X`), a hibernating WebSocket, client-side IVM only
("the DO stores and emits; it never joins, aggregates, or runs IVM"), and
`reset` + snapshot on a stale reconnect. Strong independent validation of this
design.

Differences that decide fit for us:

- **Bidirectional-first** (optimistic mutations, id parity, write-confirmation
  cursor) — the half we explicitly don't want (read-only).
- **State-convergence log, not an event log** — compacted to latest-op-per-key,
  ~2-day retention; ADR-0001 states it "permanently forecloses replaying every
  intermediate state." That fits our *derived current-state*, not our *raw
  timeline*.
- **DO owns SQLite collection tables + CDC triggers** — our DO relays an event
  log; adopting its model means moving the projection *server-side* into DO
  tables (via its `runSyncedWrite`, ADR-0006).

Adoption triggers — revisit it when **either**:

1. we move derived projections **server-side** (the DO materializes
   `scenes`/`runs` tables) — then its `runSyncedWrite` + trigger-CDC + filtered
   subscriptions are a strong fit; or
2. we want **optimistic write-back** (dashboard commands as mutations).

Until then it is a reference (read its ADRs — the best articulation of this
design going), not a dependency: 0.3.x, days old, single author, on beta
TanStack DB. Its `afterCommit` side-effect hook (ADR-0004), OLD-row capture for
filtered-sub membership (ADR-0001), and time-retention + reset-on-stale
(ADR-0009) are worth borrowing regardless.
