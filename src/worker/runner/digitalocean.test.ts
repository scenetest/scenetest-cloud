import { describe, expect, it } from 'vitest'
import { boxTags } from './digitalocean.ts'
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
