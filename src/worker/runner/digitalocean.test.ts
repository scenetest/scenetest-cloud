import { describe, expect, it } from 'vitest'
import { boxTags, dropletName } from './digitalocean.ts'
import type { BoxSpec } from './types.ts'

const box: BoxSpec = {
  boxId: 'abc-123',
  repo: 'mhsnook/sunlo',
  prNumber: 42,
  headSha: 'deadbeef',
  baseSha: null,
  baseRef: 'main',
  imageVersion: 'img-1',
}

describe('boxTags', () => {
  it('tags the droplet with runner marker, box id, repo, and PR', () => {
    expect(boxTags(box)).toEqual([
      'scenetest-runner',
      'st-box-abc-123',
      'st-repo:mhsnook-sunlo',
      'st-pr:mhsnook-sunlo:42',
    ])
  })

  it('replaces characters DigitalOcean tags forbid', () => {
    const weird = { ...box, repo: 'We.ird/Na me' }
    expect(boxTags(weird)[2]).toBe('st-repo:We-ird-Na-me')
    // Colon separators survive; nothing else illegal remains.
    for (const tag of boxTags(weird)) expect(tag).toMatch(/^[A-Za-z0-9:_-]+$/)
  })
})

describe('dropletName', () => {
  it('names the droplet for its repo and PR', () => {
    expect(dropletName(box)).toBe('mhsnook-sunlo-pr-42')
  })

  it('replaces characters a hostname forbids', () => {
    expect(dropletName({ ...box, repo: 'We.ird/Na me_x' })).toBe('we-ird-na-me-x-pr-42')
  })

  it('truncates the repo part to keep the name a valid hostname label', () => {
    const long = dropletName({ ...box, repo: `${'a'.repeat(40)}/${'b'.repeat(40)}` })
    expect(long.length).toBeLessThanOrEqual(63)
    expect(long.endsWith('-pr-42')).toBe(true)
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
  })

  it('falls back when the repo sanitizes to nothing', () => {
    expect(dropletName({ ...box, repo: '///' })).toBe('st-box-pr-42')
  })
})
