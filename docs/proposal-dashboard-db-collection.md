# Proposal: a read-only TanStack DB collection for the dashboard widget

**To:** scenetest-js maintainers (`@scenetest/dashboard`)
**From:** scenetest-cloud
**Status:** proposal + working reference (no action taken in your repo)

## The ask

Build a small **TanStack DB collection type** in the dashboard widget that
consumes our **read-only event stream** (SSE in dev, WebSocket in cloud) and
exposes the run as one or more **reactive collections**. Read-only, one
direction: server → client. Folding the event stream into a collection gives
the widget live queries (filter / aggregate / sort) for free, incremental via
TanStack DB's query engine, instead of hand-rolling event reduction in
component state.

You own the architecture. Below is the contract you'd consume, a suggested
shape, and a working reference you can lift from — not a prescription.

## The contract you consume

It's one **ordered, resumable, read-only stream of protocol events** — the
`RunEvent` vocabulary you already own in `@scenetest/protocol`
(`run:start`, `scene:start`, `assertion`, `scene:end`, …). Two properties are
all a consumer needs:

- **Every event carries a monotonic `seq`.** Dedupe on it (a register-first /
  replay overlap can deliver an event twice) and resume from your last `seq`.
- **Reconnect replays the gap.** Same semantics as SSE `Last-Event-ID`.

Concrete framings (same events, two transports):

- **Cloud (WS):** `GET /api/runs/:runId/ws?sinceSeq=<n>` → frames
  `{ kind: 'event', seq, payload }` where `payload` is the JSON string of a
  `RunEvent`. On connect the DO replays `seq > sinceSeq`, then streams live.
- **Dev (SSE):** the receiver's broadcast — the same `RunEvent`s, your existing
  mechanism.

That's the whole surface. No CRDT, no new wire protocol, no write-back.

## Suggested shape (your call)

A `Transport`-fed collection — i.e. drive it off the widget's existing
`transport.subscribe(onEvent)`, so dev (SSE) and cloud (WS) share one consumer:

- A **sync reducer** folds `RunEvent`s into row ops (`begin`/`write`/`commit`),
  one projection per collection (e.g. `scenes` from `scene:start`/`scene:end`).
- **No mutation handlers** → the sync reducer is the sole writer; a stray
  client write throws. (Note: TanStack DB's sync path doesn't validate or
  transform — synced rows land raw, which is exactly right for a replica. A
  schema, if you add one, only gates *client mutations*, which you won't have.
  So validation is a read-time concern, not an ingest gate.)
- **Live queries** via `useLiveQuery` (`groupBy`/`count`, `where`, `orderBy`).

## Working reference

A runnable proof-of-shape lives in **scenetest-cloud**, branch
`claude/ws-shape-collection-poc`:

- `runShapeSource` — the cloud WS source (resume by `seq`, dedupe, reconnect).
  *This is our transport's guts; it stays in cloud.*
- `wsShapeSync` — the reusable collection type (the part worth lifting).
- `collections/scenes.ts` — a concrete projection + a `SceneRow` type.
- `ScenesPanel.tsx` — three live queries (aggregate / filter / sort).
- tests, incl. one proving the aggregate recomputes incrementally.

Lift the **collection** (`wsShapeSync` + a projection); leave the cloud
transport with us.

## What we are *not* asking for

Not a CRDT, not bidirectional sync, not multi-DO anything, not a new protocol.
Just a reactive read model over the stream the widget already receives.

---

## Notes from our spike (secondary — your architecture, your call)

These came up while prototyping; flagging them so you don't have to
rediscover, not to constrain you.

- **It's transport-agnostic.** The collection only needs `onEvent`; the source
  is a pluggable connector. Today that's one per environment (WS in cloud, SSE
  in dev). A third — a `.jsonl` reader — is nearly free and would let the *same*
  collection power recorded-run / historical / offline views (our run logs are
  one `RunEvent` per line). One connector for live is fine; the point is the
  collection doesn't care which.
- **It's a read-model, not a receiver client.** The receiver is the *ingest*
  half (producers POST in → sink). This is the *read* half — a client of the
  broadcast layer (your SSE in dev, our DO viewer channel in cloud), surfaced
  through the `Transport`. Different end of the pipe; don't fold it into the
  receiver.
- **Two kinds of data, different fit.** The *raw event timeline*
  (assertions/actions — every intermediate state matters; the terminal view
  replays it) stays an event stream. *Derived current-state* (scene/run status —
  latest-op-per-key) is the natural shape for a collection of rows. A collection
  is a projection of the former into the latter.
- **Prior art worth reading:** `grrowl/tanstack-do-db-collection` lands the same
  core (single writer, contiguous log, one `seq` cursor for deltas + reconnect,
  client-side IVM, reset-on-stale-reconnect). It's bidirectional + DO-owns-tables
  + a state-convergence (compacted) log, whereas we're read-only over an event
  log — so it's a reference, not a drop-in. Worth revisiting if you ever want
  optimistic write-back or server-side projection.
