# Per-PR dashboard

Status: design. The cloud dashboard is organized around the **pull request**,
not the run. A PR is the stable unit of work; runs are iterations inside it
(push again → another run). There is no run-scoped page and no run-scoped URL.

## Why

Cloud currently exposes `/r/:runId/dashboard` — one page per run, run as the
identity. Everything else in the system already keys on the PR: the Durable
Object is `prCoordinator(repo, pr_number)`, the droplet and bearer token live
on the per-PR `boxes` row, and event fan-out happens inside the per-PR
coordinator. The run-scoped viewer is the only place that pretends a run is the
unit, and it's the thing making cross-run questions ("why did this flaky scene
pass last push and fail this one?") awkward. Drop it.

## The model

Three independent layers. Each is dumber than the one above it.

1. **PR socket — run-blind.** One WebSocket per PR streams *every* event for
   the whole PR: all runs, server-ordered, immutable, append-only. It does not
   know or care which run the UI is showing. It never replays a different
   stream because the UI changed.

2. **Client collection — insert-only, keyed on `id`.** Events feed a TanStack
   DB collection. Events never change, so there is no update/upsert — only
   insert. `id` is the server-assigned, PR-global, monotonic position (a per-PR
   autoincrement in the PR object's SQLite), so it alone is unique: a new run's
   events arrive with fresh `id`s and land *alongside* earlier runs rather than
   overwriting them. `runId` is the channel discriminator the UI groups by;
   `seq` is the box's per-run sequence, carried along so the cloud log stays in
   byte parity with the box's own `.jsonl` (both keyed `(run_id, seq)`). The
   server owns ordering; the client trusts `id`.

3. **UI — derived queries.** "Selected run", "latest run per scene",
   single-run vs. cross-run views are reactive queries over the collection.
   Pure UI state. They resolve long after the socket has stopped caring, and
   changing them touches nothing below this layer.

`?run=<id>` (if used) is a deep-link into UI state — which derived view is
showing — not a route and not an input to the socket.

## URL surface

Add `paths.pr(owner, name, number)` → `/repo/:owner/:name/pr/:number`, a route
inside the existing SPA shell (`App.tsx` `<Router>`, mirrored in `paths.ts` and
the worker shell fall-through). Hierarchy:

```
overview → repo detail (PR list) → /repo/:owner/:name/pr/:number → (in-page run views)
```

`/r/:runId/*` is removed, not redirected.

## The widget

scenetest-js folds the runner + home/app into the dashboard widget, so
`mountDashboard` becomes the full per-PR experience. Cloud's job shrinks to:
serve the PR route, mount the widget, hand it a PR-scoped transport. The widget
owns run selection and all derived views; cloud owns transport + auth + data.

## Transport

PR-scoped, not run-scoped:

```
createCloudPrTransport(owner, repo, number)
```

It opens one PR socket and feeds the collection. It does **not** switch streams
when the UI selects a run. partysocket stays for reconnect/backoff and resume
(the url provider re-reads a cursor on each connect, same Last-Event-ID
semantics as today) — but it carries PR identity + a resume cursor, never a
"selected run".

## Backend work (this repo) — done

Built on main's inversion (the PR object owns the event log in its own SQLite;
D1 holds only projections; R2 is the per-run archive — see architecture.md,
"The log and its projections"). One DO is one PR, so the whole log *is* the PR.

- **Stream position = per-PR autoincrement `log.id`.** The DO's `log` table is
  `id INTEGER PRIMARY KEY AUTOINCREMENT` with `UNIQUE(run_id, seq)`. `id` is the
  single PR-global, monotonic position the PR stream orders and resumes on; the
  client keys its collection on it. Per-PR (one object each), so no cross-PR
  gaps. `(run_id, seq)` stays the box's per-run sequence — and in byte parity
  with the box's `.jsonl`.
- **Idempotent ingest.** `INSERT OR IGNORE … RETURNING id`: a resent
  `(run_id, seq)` is a no-op and returns no row, so PR fan-out never duplicates;
  inserted rows carry their `id`.
- **DO `/pr-viewer-connect?sinceId=`**: registers a PR-level viewer (`prv` tag),
  replays the whole log (`WHERE id > ? ORDER BY id`), and fans live events framed
  `{ id, runId, seq, payload }`. Survives run boundaries: a new `run:start` is
  just more rows on the same stream. (No run filter — the object is the PR.)
- **Worker route `/api/cloud/repos/:owner/:name/pr/:number/ws`** → the DO. Client
  adapter `createCloudPrTransport` (`?sinceId`).
- e2e covers replay, ascending-no-duplicate ids, per-run `seq` preserved, and
  `sinceId` resume.

## Removal of /r/:runId — done

The run-scoped page is gone: deleted `run.ts`, the worker HTML shell
(`html.ts` / `renderDashboard`), the `/r/:runId/dashboard` routes, the legacy
unused per-run SSE (`/api/runs/:runId/events`, `streamRunEvents`), the `run`
vite entry + `/r` proxy, and the per-run client adapter. PrDetail now mounts the
widget on `createCloudPrTransport`. Stragglers repointed: `debug.ts` returns a
PR url, AddProjectWizard links to the project page, the OAuth `safeNext` test
uses a PR path.

Kept on purpose: the run-scoped **data plane** `/api/runs/:runId/{ws,log,
commands}`. The per-run viewer WS is no longer used by any page, but it still
backs run-granular e2e observation and the per-run **R2 archive fallback**. (The
PR stream now folds archived runs back in itself — see "Archived/reset runs in
the PR stream" — so this is no longer the only path to archived data; removing
the per-run viewer is a separate cleanup.)

## Archived/reset runs in the PR stream — done

When a run completes its log is flushed to a per-run R2 `.jsonl` and the PR
object may be reset at teardown, so the PR-anchored stream has to recreate an
archived run's slice from R2 — and cross-run flaky history is the whole point.
Resolved by **persisting the log's `id`** (the chosen option from the original
note): the archive line is the full log row `{"id":N,"seq":M,"ts":T,"payload":…}`,
not just the box's fact. On PR-viewer connect, `rehydrateArchived` folds every
archived run for the PR that isn't already live back into the object's SQLite
**under its original `id`** (`INSERT OR IGNORE`), so `replayPrTo` serves it in
PR-global order with no other change. Because the `id` is restored rather than
reassigned, restore order is irrelevant — newest-first revival replays the same
stream as oldest-first. `POST /reset` models teardown with a `DELETE` (not a
drop) so the autoincrement high-water mark survives and re-folded ids never
collide with ids minted for post-revival runs. The `/log` download projects the
archive back to the box-compatible `{seq,payload}` view, so it reads the same
served live or from R2; byte-parity with the box's own file is no longer
claimed, only "appropriate similarity." (e2e: "re-fold archived run into the PR
stream", asserting the ids reproduce exactly across a reset.)

## Open decisions

- **Commands on the PR transport.** `sendCommand` is run-scoped at the worker
  (`/api/runs/:runId/commands`); the PR transport throws until the multi-run
  widget defines routing to the active run.
- **Scene identity across runs** for "latest run per scene" queries. Decision:
  store `filename`, `title`, and `ordinal` (index within file) all as plain
  attributes on each event, and derive identity as `filename + title`, using
  ordinal only as a tiebreaker when titles collide within a file. Rationale:
  ordinal-as-identity fails by *misattributing* history (delete/insert/reorder
  shifts indices, so a scene silently inherits another's flakiness record),
  whereas title-as-identity fails by *minting a fresh identity* on rename — a
  clean reset, which is acceptable. Because identity is derived (the collection
  key is `id`), the rule can change later by recomputing over stored
  attributes — no migration, no data loss — so this default is not a
  commitment.

## Blocks on scenetest-js

- Widget absorbing runner/home (full per-PR experience).
- Transport interface shape the widget expects (PR-scoped; collection-filling).
Everything else — PR route, PR socket, DO PR-subscribe, transport, removal —
is local to this repo.
