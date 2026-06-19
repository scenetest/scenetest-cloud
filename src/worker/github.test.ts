import { afterEach, describe, expect, it, vi } from 'vitest'
import { postCommitStatus, verifyWebhookSignature } from './github.ts'

const SECRET = 'webhook-test-secret'

// Mirrors what GitHub does: HMAC-SHA256 over the raw body, hex, prefixed.
async function sign(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)))
  return 'sha256=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed body', async () => {
    const body = JSON.stringify({ action: 'opened', number: 7 })
    expect(await verifyWebhookSignature(SECRET, body, await sign(SECRET, body))).toBe(true)
  })

  it('rejects a tampered body', async () => {
    const body = JSON.stringify({ action: 'opened', number: 7 })
    const sig = await sign(SECRET, body)
    const tampered = JSON.stringify({ action: 'opened', number: 8 })
    expect(await verifyWebhookSignature(SECRET, tampered, sig)).toBe(false)
  })

  it('rejects a signature made with the wrong secret', async () => {
    const body = '{"zen":"Design for failure."}'
    const sig = await sign('some-other-secret', body)
    expect(await verifyWebhookSignature(SECRET, body, sig)).toBe(false)
  })

  it('rejects missing and malformed headers', async () => {
    const body = '{}'
    expect(await verifyWebhookSignature(SECRET, body, null)).toBe(false)
    expect(await verifyWebhookSignature(SECRET, body, '')).toBe(false)
    expect(await verifyWebhookSignature(SECRET, body, 'sha1=abc')).toBe(false)
    expect(await verifyWebhookSignature(SECRET, body, 'sha256=nothex')).toBe(false)
    // Right shape, wrong value.
    expect(await verifyWebhookSignature(SECRET, body, 'sha256=' + '0'.repeat(64))).toBe(false)
  })
})

describe('postCommitStatus', () => {
  afterEach(() => vi.restoreAllMocks())

  const args = {
    repo: 'owner/name',
    sha: 'abc123def456',
    status: 'passed',
    description: '3 scenes, 0 failing',
    targetUrl: 'https://ci.example/repo/owner/name/pr/7?run=r1',
  }

  it('skips (no fetch) when the token is absent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await postCommitStatus({}, args)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips an unknown status even with a token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await postCommitStatus({ GITHUB_API_TOKEN: 't' }, { ...args, status: 'weird' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps run status → state and posts to the statuses endpoint', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 201 }))
    const cases: Array<[string, string]> = [
      ['queued', 'pending'],
      ['running', 'pending'],
      ['passed', 'success'],
      ['failed', 'failure'],
      ['cancelled', 'error'],
    ]
    for (const [status, state] of cases) {
      await postCommitStatus({ GITHUB_API_TOKEN: 't' }, { ...args, status })
      const [url, init] = fetchMock.mock.calls.at(-1)!
      expect(url).toBe('https://api.github.com/repos/owner/name/statuses/abc123def456')
      expect(init?.method).toBe('POST')
      const headers = init?.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer t')
      const sent = JSON.parse(init?.body as string)
      expect(sent.state).toBe(state)
      expect(sent.context).toBe('scenetest')
      expect(sent.target_url).toBe(args.targetUrl)
    }
  })

  it('clamps the description to GitHub’s 140-char limit', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 201 }))
    await postCommitStatus({ GITHUB_API_TOKEN: 't' }, { ...args, description: 'x'.repeat(300) })
    const sent = JSON.parse(fetchMock.mock.calls.at(-1)![1]?.body as string)
    expect(sent.description.length).toBe(140)
  })

  it('swallows an API error (logs, does not throw)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no scope', { status: 403 }))
    await expect(postCommitStatus({ GITHUB_API_TOKEN: 't' }, args)).resolves.toBeUndefined()
  })

  it('swallows a network throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    await expect(postCommitStatus({ GITHUB_API_TOKEN: 't' }, args)).resolves.toBeUndefined()
  })
})
