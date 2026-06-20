import { describe, expect, it } from 'vitest'
import type { Env } from '../env.ts'
import { getWsSessionUser, makeSessionCookie } from './session.ts'
import { SESSION_COOKIE } from './session.ts'

const SECRET = 'test-secret-do-not-use'
const USER = { github_id: 42, github_login: 'alice' }

// Minimal Env: getWsSessionUser only touches SESSION_SECRET + ENABLE_DEBUG_ROUTES.
function env(overrides: Partial<Env> = {}): Env {
  return { SESSION_SECRET: SECRET, ...overrides } as Env
}

// Mint a real signed token by serializing a cookie and pulling the value out,
// so the tests exercise the same path the login flow produces.
async function token(): Promise<string> {
  const cookie = await makeSessionCookie(USER, env(), true)
  return (/(?:^|;\s*)session=([^;]*)/.exec(cookie) ?? [])[1]!
}

function wsReq(opts: { cookie?: string; query?: string }): Request {
  const url = `https://example.com/api/cloud/home/ws${opts.query ? `?${opts.query}` : ''}`
  const headers = new Headers()
  if (opts.cookie) headers.set('cookie', opts.cookie)
  return new Request(url, { headers })
}

describe('getWsSessionUser', () => {
  it('authenticates a valid cookie regardless of gating', async () => {
    const t = await token()
    for (const gate of [undefined, '1']) {
      const user = await getWsSessionUser(
        wsReq({ cookie: `${SESSION_COOKIE}=${t}` }),
        env({ ENABLE_DEBUG_ROUTES: gate }),
      )
      expect(user).toEqual(USER)
    }
  })

  it('refuses ?session= in cloud (gating off)', async () => {
    const t = await token()
    const user = await getWsSessionUser(wsReq({ query: `session=${t}` }), env())
    expect(user).toBeNull()
  })

  it('honors ?session= only when ENABLE_DEBUG_ROUTES=1', async () => {
    const t = await token()
    const user = await getWsSessionUser(
      wsReq({ query: `session=${t}` }),
      env({ ENABLE_DEBUG_ROUTES: '1' }),
    )
    expect(user).toEqual(USER)
  })

  it('does not let ?session= rescue a missing cookie even with a valid token', async () => {
    const t = await token()
    // Cloud: a debug/copy-pasted URL carrying a live token must not authenticate.
    const user = await getWsSessionUser(
      wsReq({ query: `session=${t}` }),
      env({ ENABLE_DEBUG_ROUTES: '0' }),
    )
    expect(user).toBeNull()
  })

  it('rejects a tampered ?session= token even when gated on', async () => {
    const user = await getWsSessionUser(
      wsReq({ query: 'session=tampered.sig' }),
      env({ ENABLE_DEBUG_ROUTES: '1' }),
    )
    expect(user).toBeNull()
  })

  it('returns null when no credential is present', async () => {
    expect(await getWsSessionUser(wsReq({}), env({ ENABLE_DEBUG_ROUTES: '1' }))).toBeNull()
  })
})
