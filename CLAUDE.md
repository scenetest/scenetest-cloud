# scenetest-cloud

Cloudflare Worker + D1 + per-PR DigitalOcean runner boxes around the
scenetest dashboard widget. Read `docs/architecture.md` before structural
changes — it is the decision record, kept current.

## Commands

- `pnpm dev` — the whole local stack: migrate local D1, wrangler dev (:8787)
  + dashboard build --watch, then seed demo repos/PRs/runs on an empty
  database. Sign in with the "Sign in as dev" button — no GitHub App needed.
  `--no-seed` skips the fixtures.
- `pnpm dev:seed` / `pnpm dev:webhook` — re-seed, or fire a signed
  `pull_request` delivery at the local worker (no tunnel)
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

## Writing style for Humans

Applies to every string a human reads: chat, commit messages, PR bodies, code
comments, UI copy, errors, docs.

- **One word per meaning.** One action, one verb, everywhere — button, toast, error, docs, commit message.
- **Say which one you mean.** "The Vite build", not "the build" — even when there's only one build.
- **Active voice, simple tense, one claim per sentence.** Under ~25 words. Lists for 3+ steps.
- **Condition before consequence.** "If the deck is empty, the button stays disabled."
- **Name the specific thing.** "Deck saved" beats "Success"; "Keep editing" beats "OK". Cut "please", "simply", "just".
- **Match the channel.** A commit says why. A code comment says only what a cold maintainer needs. UI copy uses the user's words, never the codebase's.
- **No hype, no flattery, no dunking.** State the observation and stop.
- **Hedge honestly.** Say when you don't know. Mark estimates "≈". Report failures with the output.
- **State the options and recommend one** when the decision is mine. Don't settle it silently.
