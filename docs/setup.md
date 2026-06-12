# Setup

From zero to a working deployment. Architecture in
[architecture.md](./architecture.md); runner details in
[runner-provisioning.md](./runner-provisioning.md).

## Local dev

```sh
pnpm install
cp .dev.vars.example .dev.vars   # fill in secrets (see below)
pnpm db:migrate:local
pnpm dev                          # wrangler dev (:8787) + dashboard build --watch
```

The vite dev server (`pnpm dev:dashboard`) proxies `/api`, `/auth`,
`/webhook`, and `/r` to the worker; for the proxied OAuth flow, add
`http://localhost:<vite-port>/auth/github/callback` to the GitHub App's
callback URLs.

With `ENABLE_DEBUG_ROUTES=1` in `.dev.vars` (off by default in
wrangler.toml so deploys are safe), `POST /api/debug/stub-run` fabricates a
run end-to-end without GitHub or DigitalOcean — the fastest way to see the
dashboard working.

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
wrangler secret put GITHUB_API_TOKEN        # optional: lifts GitHub API rate limits for pipeline stage-hashing
```

Locally, the same names go in `.dev.vars` (see `.dev.vars.example`).

## Database

```sh
wrangler d1 create scenetest-cloud-<you>    # once; update database_id in wrangler.toml
pnpm db:migrate                              # remote
pnpm db:migrate:local                        # local dev
```

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
4. The cron trigger (every 10 minutes, already in wrangler.toml) advances
   image builds, provisions boxes that waited on them, and reaps finished
   and over-age droplets; `RUNNER_MAX_AGE_MINUTES` (default 30) is the
   hard cap.

## Deploy

```sh
pnpm deploy   # builds the dashboard, then wrangler deploy
```
