import type { Handler } from '../router.ts'
import { isHttps, safeNext } from './github-oauth.ts'
import { makeSessionCookie } from './session.ts'

// GET /auth/dev-login?login=<name>&next=<path>
//
// Mints a session for a fabricated identity and adds it to allowed_user, so
// local dev needs no GitHub App, no client secret, and no callback URL.
// Registered through devOnly(), the same gate as /api/debug/* — off by default
// in wrangler.toml, so a deployed worker serves 404 here. The signed cookie is
// the real one from session.ts: everything downstream sees an ordinary
// signed-in user.
export const getDevLogin: Handler = async (req, env) => {
  const url = new URL(req.url)
  const login = (url.searchParams.get('login') || 'dev').slice(0, 39)
  const next = safeNext(url.searchParams.get('next'))
  const githubId = devGithubId(login)

  await env.DB.prepare(
    `INSERT INTO allowed_user (github_id, github_login, added_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(github_id) DO UPDATE SET github_login = excluded.github_login`,
  )
    .bind(githubId, login, Date.now())
    .run()

  const cookie = await makeSessionCookie({ github_id: githubId, github_login: login }, env, isHttps(req))
  return new Response(null, { status: 302, headers: { location: next, 'set-cookie': cookie } })
}

// Fabricated ids are negative: GitHub's are positive, so a dev row can never
// collide with (or masquerade as) a real user in allowed_user. Derived from the
// login so signing in twice reuses one row.
function devGithubId(login: string): number {
  let h = 2166136261
  for (let i = 0; i < login.length; i++) {
    h ^= login.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return -((h >>> 0) % 1_000_000_000) - 1
}
