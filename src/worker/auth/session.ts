import type { AuthedUser, Env } from '../env.ts'
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
  let token: string | undefined = cookies[SESSION_COOKIE]
  // WebSocket upgrade requests from browsers carry cookies automatically
  // (same-origin). Test clients that cannot set headers use ?session= instead.
  if (!token && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    token = new URL(req.url).searchParams.get('session') ?? undefined
  }
  if (!token) return null
  const payload = await verifyPayload<SessionPayload>(token, env.SESSION_SECRET)
  if (!payload) return null
  if (payload.exp < Math.floor(Date.now() / 1000)) return null
  return { github_id: payload.sub, github_login: payload.login }
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
