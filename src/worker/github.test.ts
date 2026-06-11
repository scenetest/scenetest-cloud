import { describe, expect, it } from 'vitest'
import { verifyWebhookSignature } from './github.ts'

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
