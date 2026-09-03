import { devRoutesEnabled, type AuthedUser, type Env } from '../env.ts'
import type { Handler } from '../router.ts'
import { parseCookies, serializeCookie, signPayload, verifyPayload } from './cookies.ts'

export const SESSION_COOKIE = 'session'
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days

interface SessionPayload {
  sub: number     // github_id
  login: string
  exp: number     // unix seconds
}

export async function getSessionUser(req: Request, env: Env): Promise<AuthedUser | null> {
  const cookies = parseCookies(req.headers.get('cookie'))
  const token = cookies[SESSION_COOKIE]
  if (!token) return null
  return verifySessionToken(token, env)
}

// Verify a raw session token, independent of how it arrived. getSessionUser
// pulls it from the cookie; getWsSessionUser also accepts it via ?session=
// under dev gating (so this stays transport-agnostic).
export async function verifySessionToken(token: string, env: Env): Promise<AuthedUser | null> {
  const payload = await verifyPayload<SessionPayload>(token, env.SESSION_SECRET)
  if (!payload) return null
  if (payload.exp < Math.floor(Date.now() / 1000)) return null
  return { github_id: payload.sub, github_login: payload.login }
}

// Session auth for the WebSocket routes. The cookie is always honored; the
// `?session=` query fallback is honored ONLY under dev/test gating
// (ENABLE_DEBUG_ROUTES), and refused in cloud.
//
// Why the fallback is gated rather than unconditional: `?session=` carries the
// same 30-day HMAC-signed bearer token as the cookie, and a bearer in a URL is
// a recognized anti-pattern (OWASP "session ID in URL"; CWE-598) — query
// strings land in access/proxy/CDN logs, browser history, and Referer, where a
// cookie never does. The signature stops forgery, not theft-and-replay, so a
// token read from a log is a live credential. Real browsers send the cookie
// automatically and never build a `?session=` URL; the fallback exists purely
// for test clients (Node's global WebSocket follows WHATWG and drops custom
// headers, so they cannot send the cookie). That affordance belongs in
// local/test, not against the production deployment.
export async function getWsSessionUser(req: Request, env: Env): Promise<AuthedUser | null> {
  const cookies = parseCookies(req.headers.get('cookie'))
  let token = cookies[SESSION_COOKIE]
  if (!token && devRoutesEnabled(env)) {
    token = new URL(req.url).searchParams.get('session') ?? undefined
  }
  return token ? verifySessionToken(token, env) : null
}

export async function makeSessionCookie(
  user: AuthedUser,
  env: Env,
  isHttps: boolean,
): Promise<string> {
  const payload: SessionPayload = {
    sub: user.github_id,
    login: user.github_login,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  }
  const value = await signPayload(payload, env.SESSION_SECRET)
  return serializeCookie(SESSION_COOKIE, value, {
    maxAge: SESSION_TTL_SECONDS,
    httpOnly: true,
    secure: isHttps,
    sameSite: 'Lax',
  })
}

export function clearSessionCookie(isHttps: boolean): string {
  return serializeCookie(SESSION_COOKIE, '', {
    maxAge: 0,
    httpOnly: true,
    secure: isHttps,
    sameSite: 'Lax',
  })
}

export function jsonUnauthorized(): Response {
  return Response.json({ error: 'unauthorized' }, { status: 401 })
}

export function redirectToLogin(req: Request): Response {
  const url = new URL(req.url)
  const next = url.pathname + url.search
  const target = `/auth/github/login?next=${encodeURIComponent(next)}`
  return new Response(null, { status: 302, headers: { location: target } })
}

export type AuthedHandler = (
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Record<string, string>,
  user: AuthedUser,
) => Promise<Response> | Response

// Session auth, declared where the route is registered. The wrapped handler
// receives the verified user; routes without this wrapper are public or carry
// their own auth (bearer, webhook HMAC).
export function withSession(
  handler: AuthedHandler,
  onUnauthed: 'json' | 'redirect' = 'json',
): Handler {
  return async (req, env, ctx, params) => {
    const user = await getSessionUser(req, env)
    if (!user) return onUnauthed === 'json' ? jsonUnauthorized() : redirectToLogin(req)
    return handler(req, env, ctx, params, user)
  }
}
