import type { Env } from '../env.ts'
import {
  parseCookies,
  serializeCookie,
  signPayload,
  verifyPayload,
} from './cookies.ts'
import { clearSessionCookie, makeSessionCookie } from './session.ts'

const STATE_COOKIE = 'oauth_state'
const STATE_TTL_SECONDS = 600 // 10 min
const SCOPE = 'read:user'

interface StatePayload {
  nonce: string
  next: string
  exp: number
}

interface GitHubUser {
  id: number
  login: string
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function isHttps(req: Request): boolean {
  return new URL(req.url).protocol === 'https:'
}

function safeNext(input: string | null | undefined): string {
  // Only allow same-origin paths.
  if (!input || !input.startsWith('/') || input.startsWith('//')) return '/'
  return input
}

export async function getGithubLogin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)
  const next = safeNext(url.searchParams.get('next'))
  const nonce = randomHex(16)

  const state: StatePayload = {
    nonce,
    next,
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
  }
  const stateToken = await signPayload(state, env.SESSION_SECRET)

  const redirectUri = `${url.origin}/auth/github/callback`
  const authorizeUrl = new URL('https://github.com/login/oauth/authorize')
  authorizeUrl.searchParams.set('client_id', env.GITHUB_OAUTH_CLIENT_ID)
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('scope', SCOPE)
  authorizeUrl.searchParams.set('state', nonce)
  authorizeUrl.searchParams.set('allow_signup', 'false')

  const stateCookie = serializeCookie(STATE_COOKIE, stateToken, {
    maxAge: STATE_TTL_SECONDS,
    httpOnly: true,
    secure: isHttps(req),
    sameSite: 'Lax',
  })

  return new Response(null, {
    status: 302,
    headers: { location: authorizeUrl.toString(), 'set-cookie': stateCookie },
  })
}

export async function getGithubCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state')
  if (!code || !stateParam) return new Response('Missing code/state', { status: 400 })

  const cookies = parseCookies(req.headers.get('cookie'))
  const stateCookie = cookies[STATE_COOKIE]
  if (!stateCookie) return new Response('Missing state cookie', { status: 400 })

  const state = await verifyPayload<StatePayload>(stateCookie, env.SESSION_SECRET)
  if (!state) return new Response('Invalid state', { status: 400 })
  if (state.exp < Math.floor(Date.now() / 1000)) {
    return new Response('Expired state', { status: 400 })
  }
  if (state.nonce !== stateParam) return new Response('State mismatch', { status: 400 })

  // Exchange code for access token.
  const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/auth/github/callback`,
    }),
  })
  if (!tokenResp.ok) return new Response('Token exchange failed', { status: 502 })
  const tokenJson = (await tokenResp.json()) as { access_token?: string }
  const accessToken = tokenJson.access_token
  if (!accessToken) return new Response('No access_token returned', { status: 502 })

  // Fetch GitHub user.
  const userResp = await fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'scenetest-cloud',
    },
  })
  if (!userResp.ok) return new Response('GitHub /user failed', { status: 502 })
  const gh = (await userResp.json()) as GitHubUser
  if (typeof gh.id !== 'number' || !gh.login) {
    return new Response('Malformed GitHub user', { status: 502 })
  }

  // Authorize against allowed_user. Bootstrap path: if table is empty and the
  // login matches BOOTSTRAP_ALLOWED_LOGIN, insert this user.
  const existing = await env.DB.prepare(
    'SELECT github_id, github_login FROM allowed_user WHERE github_id = ?1',
  )
    .bind(gh.id)
    .first<{ github_id: number; github_login: string }>()

  if (!existing) {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM allowed_user')
      .first<{ n: number }>()
    const isFirstUser = (count?.n ?? 0) === 0
    const bootstrapMatch =
      env.BOOTSTRAP_ALLOWED_LOGIN &&
      gh.login.toLowerCase() === env.BOOTSTRAP_ALLOWED_LOGIN.toLowerCase()
    if (!isFirstUser || !bootstrapMatch) {
      return new Response('Not authorized', { status: 403 })
    }
    await env.DB.prepare(
      'INSERT INTO allowed_user (github_id, github_login, added_at, added_by) VALUES (?1, ?2, ?3, NULL)',
    )
      .bind(gh.id, gh.login, Date.now())
      .run()
  } else if (existing.github_login !== gh.login) {
    // Keep the cached login fresh if the user renamed.
    await env.DB.prepare(
      'UPDATE allowed_user SET github_login = ?1 WHERE github_id = ?2',
    )
      .bind(gh.login, gh.id)
      .run()
  }

  const sessionCookie = await makeSessionCookie(
    { github_id: gh.id, github_login: gh.login },
    env,
    isHttps(req),
  )
  const clearState = serializeCookie(STATE_COOKIE, '', {
    maxAge: 0,
    httpOnly: true,
    secure: isHttps(req),
    sameSite: 'Lax',
  })

  const headers = new Headers({ location: safeNext(state.next) })
  headers.append('set-cookie', sessionCookie)
  headers.append('set-cookie', clearState)
  return new Response(null, { status: 302, headers })
}

export async function postLogout(req: Request): Promise<Response> {
  return new Response(null, {
    status: 302,
    headers: {
      location: '/',
      'set-cookie': clearSessionCookie(isHttps(req)),
    },
  })
}
