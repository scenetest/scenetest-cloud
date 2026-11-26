import { describe, expect, it } from 'vitest'
import { classifyWebhook, isForkPr } from './webhook-github.ts'

describe('classifyWebhook', () => {
  it('ignores ping regardless of repo or action', () => {
    expect(classifyWebhook('ping', undefined, true, false)).toEqual({ kind: 'ignore', reason: 'ping' })
    expect(classifyWebhook('ping', undefined, false, false)).toEqual({ kind: 'ignore', reason: 'ping' })
  })

  it('ignores non-pull_request events, naming the event', () => {
    expect(classifyWebhook('push', 'whatever', true, false)).toEqual({
      kind: 'ignore',
      reason: 'event:push',
    })
    expect(classifyWebhook('issues', 'opened', true, false)).toEqual({
      kind: 'ignore',
      reason: 'event:issues',
    })
  })

  it('ignores pull_request events on unwatched repos before considering the action', () => {
    expect(classifyWebhook('pull_request', 'opened', false, false)).toEqual({
      kind: 'ignore',
      reason: 'unwatched-repo',
    })
  })

  it('creates a run for opened, synchronize, and reopened on a watched repo', () => {
    for (const action of ['opened', 'synchronize', 'reopened']) {
      expect(classifyWebhook('pull_request', action, true, false)).toEqual({ kind: 'create-run' })
    }
  })

  it('marks the PR closed on close', () => {
    expect(classifyWebhook('pull_request', 'closed', true, false)).toEqual({ kind: 'pr-closed' })
  })

  it('ignores other pull_request actions, naming the action', () => {
    for (const action of ['labeled', 'assigned', 'edited', 'review_requested']) {
      expect(classifyWebhook('pull_request', action, true, false)).toEqual({
        kind: 'ignore',
        reason: `action:${action}`,
      })
    }
  })

  it('ignores a fork PR for every action that would create a run', () => {
    for (const action of ['opened', 'synchronize', 'reopened']) {
      expect(classifyWebhook('pull_request', action, true, true)).toEqual({
        kind: 'ignore',
        reason: 'fork-pr',
      })
    }
  })

  it('still closes a fork PR, so a box it already holds gets torn down', () => {
    expect(classifyWebhook('pull_request', 'closed', true, true)).toEqual({ kind: 'pr-closed' })
  })

  it('reports an unwatched repo ahead of the fork check', () => {
    expect(classifyWebhook('pull_request', 'opened', false, true)).toEqual({
      kind: 'ignore',
      reason: 'unwatched-repo',
    })
  })
})

describe('isForkPr', () => {
  const pr = (head: { id?: number; full_name: string } | null | undefined, base?: { id?: number; full_name: string }) => ({
    repository: { id: 1, full_name: 'acme/app' },
    pull_request: {
      state: 'open',
      head: { sha: 'abc', ...(head !== undefined ? { repo: head } : {}) },
      base: { ref: 'main', sha: 'def', ...(base ? { repo: base } : {}) },
    },
  })

  it('treats a same-repo branch as not a fork', () => {
    expect(isForkPr(pr({ id: 1, full_name: 'acme/app' }, { id: 1, full_name: 'acme/app' }))).toBe(false)
  })

  it('treats a head in another repo as a fork', () => {
    expect(isForkPr(pr({ id: 2, full_name: 'mallory/app' }, { id: 1, full_name: 'acme/app' }))).toBe(true)
  })

  it('compares repo ids over names, so a renamed base repo is not a fork', () => {
    expect(isForkPr(pr({ id: 1, full_name: 'acme/old-name' }, { id: 1, full_name: 'acme/app' }))).toBe(false)
    // Same name, different id: a fork that took the base's old name.
    expect(isForkPr(pr({ id: 2, full_name: 'acme/app' }, { id: 1, full_name: 'acme/app' }))).toBe(true)
  })

  it('falls back to a case-insensitive name compare when ids are absent', () => {
    expect(isForkPr(pr({ full_name: 'Acme/App' }, { full_name: 'acme/app' }))).toBe(false)
    expect(isForkPr(pr({ full_name: 'mallory/app' }, { full_name: 'acme/app' }))).toBe(true)
  })

  it('uses the top-level repository when base.repo is missing', () => {
    expect(isForkPr(pr({ id: 1, full_name: 'acme/app' }))).toBe(false)
    expect(isForkPr(pr({ id: 2, full_name: 'mallory/app' }))).toBe(true)
  })

  it('fails closed when the head repo is null (deleted fork) or missing', () => {
    expect(isForkPr(pr(null, { id: 1, full_name: 'acme/app' }))).toBe(true)
    expect(isForkPr(pr(undefined, { id: 1, full_name: 'acme/app' }))).toBe(true)
  })
})
