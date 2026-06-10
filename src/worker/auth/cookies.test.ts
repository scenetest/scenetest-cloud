import { describe, expect, it } from 'vitest'
import {
  parseCookies,
  serializeCookie,
  signPayload,
  verifyPayload,
} from './cookies.ts'

const SECRET = 'test-secret-do-not-use'

describe('signPayload / verifyPayload', () => {
  it('roundtrips a payload', async () => {
    const payload = { sub: 42, login: 'alice', exp: 1700000000 }
    const token = await signPayload(payload, SECRET)
    expect(token).toContain('.')
    const got = await verifyPayload<typeof payload>(token, SECRET)
    expect(got).toEqual(payload)
  })

  it('rejects a tampered payload section', async () => {
    const token = await signPayload({ sub: 42, login: 'alice' }, SECRET)
    const [, sig] = token.split('.')
    // Swap in a payload for a different user; signature won't match.
    const forged = await signPayload({ sub: 1, login: 'mallory' }, SECRET)
    const [forgedPayload] = forged.split('.')
    const mixed = `${forgedPayload}.${sig}`
    expect(await verifyPayload(mixed, SECRET)).toBeNull()
  })

  it('rejects a tampered signature', async () => {
    const token = await signPayload({ sub: 42 }, SECRET)
    const [payload] = token.split('.')
    const mangled = `${payload}.AAAAAAAAAAAAAAAA`
    expect(await verifyPayload(mangled, SECRET)).toBeNull()
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await signPayload({ sub: 42 }, SECRET)
    expect(await verifyPayload(token, 'other-secret')).toBeNull()
  })

  it('returns null for malformed input', async () => {
    expect(await verifyPayload('no-dot-here', SECRET)).toBeNull()
    expect(await verifyPayload('', SECRET)).toBeNull()
    expect(await verifyPayload('.', SECRET)).toBeNull()
  })

  it('roundtrips payloads containing unicode + url-unsafe bytes', async () => {
    const payload = { login: '🍕/+=', note: 'hi & bye' }
    const token = await signPayload(payload, SECRET)
    expect(await verifyPayload(token, SECRET)).toEqual(payload)
  })
})

describe('parseCookies', () => {
  it('parses a single cookie', () => {
    expect(parseCookies('session=abc')).toEqual({ session: 'abc' })
  })

  it('parses multiple cookies and trims whitespace', () => {
    expect(parseCookies('a=1; b=2;c=3 ')).toEqual({ a: '1', b: '2', c: '3' })
  })

  it('decodes percent-encoded values', () => {
    expect(parseCookies('next=%2Fhome%3Ffoo%3Dbar')).toEqual({
      next: '/home?foo=bar',
    })
  })

  it('returns {} for null/empty header', () => {
    expect(parseCookies(null)).toEqual({})
    expect(parseCookies('')).toEqual({})
  })

  it('ignores malformed segments', () => {
    expect(parseCookies('garbage; ok=1; =nope')).toEqual({ ok: '1' })
  })
})

describe('serializeCookie', () => {
  it('emits HttpOnly + SameSite=Lax by default', () => {
    const s = serializeCookie('s', 'v')
    expect(s).toContain('s=v')
    expect(s).toContain('Path=/')
    expect(s).toContain('HttpOnly')
    expect(s).toContain('SameSite=Lax')
    expect(s).not.toContain('Secure')
  })

  it('includes Secure when requested', () => {
    expect(serializeCookie('s', 'v', { secure: true })).toContain('Secure')
  })

  it('encodes the value', () => {
    expect(serializeCookie('s', 'a b/c')).toContain('s=a%20b%2Fc')
  })

  it('emits Max-Age when set, including 0 for delete', () => {
    expect(serializeCookie('s', '', { maxAge: 0 })).toContain('Max-Age=0')
    expect(serializeCookie('s', 'v', { maxAge: 3600 })).toContain('Max-Age=3600')
  })
})
