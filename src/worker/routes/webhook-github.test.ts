import { describe, expect, it } from 'vitest'
import { classifyWebhook } from './webhook-github.ts'

describe('classifyWebhook', () => {
  it('ignores ping regardless of repo or action', () => {
    expect(classifyWebhook('ping', undefined, true)).toEqual({ kind: 'ignore', reason: 'ping' })
    expect(classifyWebhook('ping', undefined, false)).toEqual({ kind: 'ignore', reason: 'ping' })
  })

  it('ignores non-pull_request events, naming the event', () => {
    expect(classifyWebhook('push', 'whatever', true)).toEqual({
      kind: 'ignore',
      reason: 'event:push',
    })
    expect(classifyWebhook('issues', 'opened', true)).toEqual({
      kind: 'ignore',
      reason: 'event:issues',
    })
  })

  it('ignores pull_request events on unwatched repos before considering the action', () => {
    expect(classifyWebhook('pull_request', 'opened', false)).toEqual({
      kind: 'ignore',
      reason: 'unwatched-repo',
    })
  })

  it('creates a run for opened, synchronize, and reopened on a watched repo', () => {
    for (const action of ['opened', 'synchronize', 'reopened']) {
      expect(classifyWebhook('pull_request', action, true)).toEqual({ kind: 'create-run' })
    }
  })

  it('marks the PR closed on close', () => {
    expect(classifyWebhook('pull_request', 'closed', true)).toEqual({ kind: 'pr-closed' })
  })

  it('ignores other pull_request actions, naming the action', () => {
    for (const action of ['labeled', 'assigned', 'edited', 'review_requested']) {
      expect(classifyWebhook('pull_request', action, true)).toEqual({
        kind: 'ignore',
        reason: `action:${action}`,
      })
    }
  })
})
