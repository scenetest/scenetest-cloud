import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../env.ts'
import { getDevLogin } from './dev-login.ts'
import { verifySessionToken } from './session.ts'

const SECRET = 'test-secret-do-not-use'

function env(): Env {
  const run = vi.fn().mockResolvedValue({})
  const bind = vi.fn(() => ({ run }))
  return { SESSION_SECRET: SECRET, DB: { prepare: vi.fn(() => ({ bind })) } } as unknown as Env
}

function call(e: Env, query = '') {
  const req = new Request(`https://example.com/auth/dev-login${query}`)
  return getDevLogin(req, e, {} as ExecutionContext, {})
}

function sessionToken(res: Response): string {
  return (/(?:^|;\s*)session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '') ?? [])[1] ?? ''
}

// The dev-only gate lives in devOnly() at the route table, tested in
// middleware/dev-only.test.ts — these cover what the handler itself does.
describe('getDevLogin', () => {
  it('mints a session for the requested login', async () => {
    const res = await call(env(), '?login=alice')
    expect(res.status).toBe(302)
    const user = await verifySessionToken(sessionToken(res), env())
    expect(user?.github_login).toBe('alice')
    // Fabricated ids are negative, so a dev row can never collide with a real
    // GitHub user in allowed_user.
    expect(user!.github_id).toBeLessThan(0)
  })

  it('gives one login the same id every time', async () => {
    const first = await verifySessionToken(sessionToken(await call(env(), '?login=bo')), env())
    const second = await verifySessionToken(sessionToken(await call(env(), '?login=bo')), env())
    expect(first!.github_id).toBe(second!.github_id)
  })

  it('keeps redirects same-origin', async () => {
    const res = await call(env(), '?next=https://evil.example.com/')
    expect(res.headers.get('location')).toBe('/')
  })
})
