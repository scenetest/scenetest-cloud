# Setup

From zero to a working deployment. Architecture in
[architecture.md](./architecture.md); runner details in
[runner-provisioning.md](./runner-provisioning.md).

## Local dev

```sh
pnpm install
pnpm dev
```

That is the whole setup. `pnpm dev` migrates the local D1, starts the worker
on :8787 and the dashboard build, then seeds two demo repos with pull
requests and runs. On the sign-in screen, click **Sign in as dev**: it mints a
session for a made-up user, so local dev needs no GitHub App, no client
secret, and no callback URL. Runs execute on the stub runner
(`RUNNER_PROVIDER = "stub"`), which fabricates scenetest events in the worker
— no DigitalOcean token, no droplet.

The demo data comes from the worker's own routes, so what you see is what a
real GitHub delivery produces:

- `pnpm dev:seed` — re-seed (two watched repos, three pull requests, four
  runs). `pnpm dev --no-seed` starts with an empty database instead.
- `pnpm dev:webhook` — send a signed `pull_request` delivery to the local
  worker, the way GitHub would on a push, with no public tunnel. Defaults to a
  new commit on the seeded PR; takes `--repo owner/name --pr 7 --action opened
  --title '...'`.

The dev sign-in, the seeded webhook secret, and `/api/debug/*` all hang off
one switch, `ENABLE_DEBUG_ROUTES`, which `pnpm dev` sets for the local worker
only. It is `"0"` in wrangler.toml, so a deployed worker serves 404 on every
one of those routes.

To point local dev at a real GitHub App instead, put the real values in
`.dev.vars` (see `.dev.vars.example`) — anything you set there wins over the
dev defaults, and the GitHub sign-in button works as it does in production.

### The vite dev server

`pnpm dev:dashboard` runs vite with HMR on its own port, proxying `/api`,
`/auth`, and `/webhook` to the worker on :8787. For the proxied GitHub OAuth
flow, add `http://localhost:<vite-port>/auth/github/callback` to the GitHub
App's callback URLs; the dev sign-in needs no such registration.

## GitHub OAuth (sign-in)

1. Create a GitHub App (or OAuth App) with callback URL
   `https://<deployment>/auth/github/callback`.
2. Put the client id in `wrangler.toml` (`GITHUB_OAUTH_CLIENT_ID`) and the
   secret in `GITHUB_OAUTH_CLIENT_SECRET`.
3. Set `BOOTSTRAP_ALLOWED_LOGIN` in `wrangler.toml` to your GitHub login.
   The first matching sign-in seeds `allowed_user`; everyone after that is
   added via `POST /api/admin/users`.

## Webhooks (run triggering)

1. On the repo (or org), add a webhook: payload URL
   `https://<deployment>/webhook/github`, content type `application/json`,
   events: pull requests. Generate a secret and set it as
   `GITHUB_WEBHOOK_SECRET`.
2. Watch the repo from the deployment: `POST /api/admin/repos` with
   `{ "owner": "...", "name": "..." }` (events from unwatched repos are
   recorded in `webhook_deliveries` and ignored).
3. Open or push to a PR. A `runs` row appears, the configured runner spawns,
   and the run dashboard is at `/r/<runId>/dashboard/`. Delivery outcomes
   land in `webhook_deliveries.result`.

## Secrets

```sh
wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
wrangler secret put SESSION_SECRET          # openssl rand -hex 32
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put DO_API_TOKEN            # only for RUNNER_PROVIDER=digitalocean
wrangler secret put GITHUB_API_TOKEN        # optional: a GitHub PAT from the operator's account; see scopes below
```

Locally, the same names go in `.dev.vars` (see `.dev.vars.example`).

### `GITHUB_API_TOKEN` scopes

The token is optional and each capability degrades gracefully when it is
absent or under-scoped (it logs and skips, never failing the request):

- **Pipeline stage-hashing** (read: trees/blobs/contents) — needs no scope
  for public repos (`public_repo` suffices), only lifts the worker egress
  IP's 60/hr unauthenticated rate limit.
- **Commit statuses** (write: a `pending` status when a run starts and the
  pass/fail verdict when it ends, on the PR's head sha, so the merge button
  reflects the run) — needs `repo:status`. Without it the run still lands on
  the dashboard; only the GitHub-side status is skipped. (Check runs —
  annotations, re-run button — are the upgrade path but require a GitHub App,
  not a PAT.)

## Database

```sh
wrangler d1 create scenetest-cloud-<you>    # once; update database_id in wrangler.toml
pnpm db:migrate                              # remote
pnpm db:migrate:local                        # local dev
```

## Artifacts bucket (R2)

Run event logs are persisted as `.jsonl` objects in R2 (the `ARTIFACTS`
binding in wrangler.toml); D1 keeps only metadata. Create the bucket once:

```sh
wrangler r2 bucket create scenetest-cloud-artifacts
```

`wrangler dev` simulates R2 locally, so local dev and `pnpm e2e` need no
setup. At end of run the PR Durable Object flushes its log to
`runs/<repo>/<runId>.jsonl` (the cron, every 10 minutes, is an archive
backstop for runs that ended without a clean flush). The viewer replay and
`GET /api/runs/<runId>/log` (session-authed raw download) serve from the
object's live log while it exists, and from the artifact once the object is
reset at PR teardown.

## DigitalOcean runner

The default `RUNNER_PROVIDER = "stub"` needs nothing. To run real boxes:

1. In `wrangler.toml`, set `RUNNER_PROVIDER = "digitalocean"` and fill in
   `RUNNER_REGION`, `RUNNER_SIZE`, `PUBLIC_BASE_URL`.
2. `wrangler secret put DO_API_TOKEN` (droplet read/write + snapshot scope).
3. There is no image step: the runner snapshot builds and caches itself on
   first need (~10–15 minutes; runs triggered meanwhile queue and start
   when it's ready). See "The image builds itself" in
   [runner-provisioning.md](./runner-provisioning.md). `RUNNER_IMAGE`
   exists only to pin a snapshot manually.
4. Idle boxes are retired by the PR coordinator's Durable Object alarm
   `RUNNER_IDLE_TIMEOUT_MINUTES` (default 5) after their runs settle; the cron
   trigger (every 10 minutes, already in wrangler.toml) then destroys the
   droplet, alongside advancing image builds and provisioning boxes that waited
   on them. `RUNNER_MAX_AGE_MINUTES` (default 30) is now only the hung-box
   backstop — a hard cap for boxes the idle alarm never retired.

## Deploy

```sh
pnpm deploy   # builds the dashboard, then wrangler deploy
```

### Durable Object migrations and gradual deploys

Adding a new Durable Object class (a `[[migrations]]` entry in `wrangler.toml`,
e.g. `HomeCoordinator`) **cannot** ship via `wrangler versions upload` — gradual
deployments can't apply a DO migration, and the upload fails with
`code: 10211`. The first deploy that introduces the new class must be a full,
non-versioned **`wrangler deploy`** (top-level and `--env production`); once the
migration is applied, `wrangler versions upload` works again for later changes.

So when a change adds or renames a DO: run `wrangler deploy` once (or point the
Workers Builds deploy command at `wrangler deploy` for that release), then resume
the usual `versions upload` flow.

