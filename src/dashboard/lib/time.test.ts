import { describe, it, expect } from 'vitest'
import { relativeTime } from './time.ts'

describe('relativeTime', () => {
  const now = Date.UTC(2026, 5, 12, 12, 0, 0)
  const ago = (ms: number) => relativeTime(now - ms, now)

  it('reads sub-minute as "just now"', () => {
    expect(ago(0)).toBe('just now')
    expect(ago(44_000)).toBe('just now')
  })

  it('reads minutes, hours, days, weeks', () => {
    expect(ago(2 * 60_000)).toBe('2m')
    expect(ago(59 * 60_000)).toBe('59m')
    expect(ago(3 * 3_600_000)).toBe('3h')
    expect(ago(5 * 86_400_000)).toBe('5d')
    expect(ago(2 * 7 * 86_400_000)).toBe('2w')
  })

  it('falls back to an absolute date past ~5 weeks', () => {
    const out = ago(40 * 86_400_000)
    expect(out).not.toMatch(/^\d+[mhdw]$/)
    expect(out).toBe(new Date(now - 40 * 86_400_000).toLocaleDateString())
  })

  it('treats a future timestamp as "just now"', () => {
    expect(ago(-10_000)).toBe('just now')
  })
})
