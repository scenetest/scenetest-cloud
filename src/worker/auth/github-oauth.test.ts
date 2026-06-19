import { describe, expect, it } from 'vitest'
import { safeNext } from './github-oauth.ts'

describe('safeNext', () => {
  it('returns / for null/empty/undefined', () => {
    expect(safeNext(null)).toBe('/')
    expect(safeNext(undefined)).toBe('/')
    expect(safeNext('')).toBe('/')
  })

  it('returns / when the input is not a same-origin path', () => {
    expect(safeNext('https://evil.example/path')).toBe('/')
    expect(safeNext('foo/bar')).toBe('/')
    expect(safeNext('javascript:alert(1)')).toBe('/')
  })

  it('rejects protocol-relative URLs that could redirect off-host', () => {
    expect(safeNext('//evil.example/path')).toBe('/')
    expect(safeNext('///evil.example')).toBe('/')
  })

  it('passes through legitimate same-origin paths', () => {
    expect(safeNext('/')).toBe('/')
    expect(safeNext('/repo/o/n/pr/1')).toBe('/repo/o/n/pr/1')
    expect(safeNext('/api/admin/users?page=2')).toBe('/api/admin/users?page=2')
  })
})
