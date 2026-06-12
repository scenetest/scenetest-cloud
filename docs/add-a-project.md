# Adding a project

Everything between "I have an app with scenetest scenes" and "every PR gets
a live test run." Written for the first user on their first project, and as
the source of copy for the dashboard's add-a-project flow. The pipeline file
itself has its own page: [pipeline.md](./pipeline.md).

Current constraints, up front: **public repos only** (the box clones without
credentials); webhook secret is **per-deployment**, shared by every watched
repo; runs trigger on **pull requests only** (no push-to-main runs yet).

## Phase 0 — scenes pass locally

Cloud runs execute the same scenes on a rented machine. If they don't pass
at `localhost/__scenetest` on your laptop, the cloud adds latency, not
information. Set up scenetest-js in the app first (its own docs cover this):
checks in components, the vite plugin, at least one scene, green locally.

## Phase 1 — register the repo (~1 minute)

1. Sign in at the deployment (e.g. `https://ci.msnook.xyz`) with GitHub.
   The first-ever login bootstraps the allowlist
   (`BOOTSTRAP_ALLOWED_LOGIN`); later users are added by an existing user
   via `POST /api/admin/users`.
2. Add the project: `POST /api/admin/repos` with
   `{ "owner": "...", "name": "..." }` (the dashboard form does this).
   This writes the `watched_repo` row — the allowlist that makes webhook
   events actionable. Registration works even when GitHub's API is
   rate-limited; the repo is verified opportunistically.

## Phase 2 — point the repo's webhook at us (~3 minutes, on GitHub)

Repo **Settings → Webhooks → Add webhook**:

- Payload URL: `https://<deployment>/webhook/github`
- Content type: `application/json`
- Secret: the deployment's `GITHUB_WEBHOOK_SECRET`
- Events: "Let me select individual events" → **Pull requests** only

GitHub sends a `ping` the moment the webhook is created. It lands as a
`webhook_deliveries` row with `event = 'ping'` and your repo's name — that
row existing **is** the "wiring verified" check. If it's missing, the URL
or secret is wrong; GitHub's *Recent Deliveries* tab shows what it got back
(`401` = secret mismatch).

> A GitHub App that creates the webhook itself is the planned replacement
> for this phase; until then it's two minutes of clicking.

## Phase 3 — make the repo runnable (~10–30 minutes, mostly your LLM's job)

Two files in your repo, both under `scenetest/`:

### `scenetest/pipeline.json` — how a box becomes your app

Declares the stages that take a bare machine to a running app: install
deps, reset + seed the database, build, serve. Full spec, rules of thumb,
and a step-by-step checklist written for LLMs in
[pipeline.md](./pipeline.md) — hand that page to your assistant with the
repo and review what comes back.

Strictly speaking the file is optional — without it every push rebuilds
everything via `scenetest/box-setup.sh` if that exists. But note the
first-user trap: with *neither* file, the box reports ready having set up
**nothing**, and every run fails confusingly. Treat the pipeline file as
required.

### `scenetest/box-run.sh` — how one batch of scenes executes

Called per run with:

| Variable | Meaning |
|---|---|
| `SCENETEST_RUN_ID` | id of this batch |
| `SCENETEST_SUBSET` | JSON array of scene ids, empty = all |
| `SCENETEST_LOCAL_INGEST` | local HTTP endpoint; accepts the same body as the cloud ingest and relays events to the dashboard |

Skeleton (honest caveat: until the scenes CLI grows a first-class
report-URL flag, this script bridges CLI output to the ingest itself —
this is the roughest edge of onboarding today):

```bash
#!/usr/bin/env bash
set -euo pipefail
# Run the scenes (the app is already up — the pipeline's serve stage did it)
pnpm exec scenes run --base-url http://localhost:4173 ${SCENETEST_SUBSET:+--subset "$SCENETEST_SUBSET"}
# Relay the run's event log to the dashboard
jq -c '{events: [{payload: .}]}' .scenetest/runs/latest.jsonl | while read -r batch; do
  curl -s -X POST "$SCENETEST_LOCAL_INGEST/events/$SCENETEST_RUN_ID" \
    -H 'content-type: application/json' -d "$batch" > /dev/null
done
```

A non-zero exit marks the run failed — no batch is ever left dangling.

## Phase 4 — open a PR and watch

Push a branch, open a PR. What to expect, in order:

1. `webhook_deliveries.result` = `run-created:<id>` within seconds.
2. **First PR on the deployment only** (or after a toolchain change): the
   runner image self-builds, ~10–15 minutes. The run queues — slow, not
   lost. Every later box boots from the cached snapshot in about a minute.
3. The box runs your pipeline stages, reports ready, executes the batch.
4. Live dashboard at `/r/<runId>/dashboard/`.

Subsequent pushes are where the pipeline pays: docs-only changes run
nothing; source-only changes skip install and db reset; re-runs against the
warm box take seconds.

## When it doesn't work

In escalation order:

1. GitHub → the webhook's **Recent Deliveries**: was it sent, what status
   came back?
2. `webhook_deliveries.result` in D1: `ignored:unwatched-repo` means Phase
   1 and Phase 2 disagree about the repo name; `run-created:` means the
   trigger side is fine.
3. `wrangler tail` on the worker: provisioning, image-build, and
   stage-hashing logs (coarse-fallback warnings show up here; the operator
   can set `GITHUB_API_TOKEN` to stop them).
4. The DigitalOcean console, droplets filtered by tag
   `st-repo:<owner>-<name>`: is a box up at all?
5. A run that reaches the box and fails instantly usually means a failed
   pipeline stage (box retired; fix the stage, push) or a missing
   `box-run.sh`.
