# scenetest-cloud

Cloudflare Worker + D1 + per-PR DigitalOcean runner boxes around the
scenetest dashboard widget. Read `docs/architecture.md` before structural
changes — it is the decision record, kept current.

## Commands

- `pnpm dev` — wrangler dev (:8787) + dashboard build --watch
- `pnpm typecheck` / `pnpm test` — fast checks, run on any change
- `pnpm e2e` — boots the real worker against a throwaway D1 and exercises
  auth, webhooks, the stub runner → SSE path, the dashboard shell/widget,
  and latest-wins cancellation. **Run this after touching `src/worker/**`,
  `src/dashboard/**`, or `migrations/**`.** Hermetic: never touches your
  `.dev.vars` or `.wrangler/state`.
- `pnpm db:migrate:local` — apply migrations to local dev D1

## Conventions

- No semicolons, single quotes, `.ts` import extensions.
- Auth is declared per route in `src/worker/index.ts` (session cookie,
  bearer-from-box, webhook HMAC, env-gated debug).
- D1 holds metadata only, never event-log payloads at scale (see
  architecture.md).
- `runs` own no infrastructure; the per-PR `boxes` row owns the droplet and
  bearer token.
