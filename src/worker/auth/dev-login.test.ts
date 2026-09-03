import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../env.ts'
import { getDevLogin } from './dev-login.ts'
import { verifySessionToken } from './session.ts'

const SECRET = 'test-secret-do-not-use'

// The route touches SESSION_SECRET, the gate, and one INSERT.
function env(gate?: string): Env {
  const run = vi.fn().mockResolvedValue({})
  const bind = vi.fn(() => ({ run }))
  return {
    SESSION_SECRET: SECRET,
    ENABLE_DEBUG_ROUTES: gate,
    DB: { prepare: vi.fn(() => ({ bind })) },
  } as unknown as Env
}

function call(e: Env, query = '') {
  const req = new Request(`https://example.com/auth/dev-login${query}`)
  return getDevLogin(req, e, {} as ExecutionContext, {})
}

function sessionToken(res: Response): string {
  return (/(?:^|;\s*)session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '') ?? [])[1] ?? ''
}

describe('getDevLogin', () => {
  it('is 404 without the debug gate — the deployed default', async () => {
    for (const gate of [undefined, '0']) {
      const res = await call(env(gate))
      expect(res.status).toBe(404)
      expect(res.headers.get('set-cookie')).toBeNull()
    }
  })

  it('mints a session for the requested login when gated on', async () => {
    const res = await call(env('1'), '?login=alice')
    expect(res.status).toBe(302)
    const user = await verifySessionToken(sessionToken(res), env('1'))
    expect(user?.github_login).toBe('alice')
    // Fabricated ids are negative, so a dev row can never collide with a real
    // GitHub user in allowed_user.
    expect(user!.github_id).toBeLessThan(0)
  })

  it('gives one login the same id every time', async () => {
    const first = await verifySessionToken(sessionToken(await call(env('1'), '?login=bo')), env('1'))
    const second = await verifySessionToken(sessionToken(await call(env('1'), '?login=bo')), env('1'))
    expect(first!.github_id).toBe(second!.github_id)
  })

  it('keeps redirects same-origin', async () => {
    const res = await call(env('1'), '?next=https://evil.example.com/')
    expect(res.headers.get('location')).toBe('/')
  })
})
