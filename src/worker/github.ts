// Shared bits for talking to api.github.com (OAuth user fetch, admin lookups)
// and for verifying inbound webhooks.
export const GH_API_HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'scenetest-cloud',
} as const

const enc = new TextEncoder()

// GitHub signs the raw request body with HMAC-SHA256 and sends
// 'sha256=<hex>' in X-Hub-Signature-256. Verify against the raw body bytes,
// before any JSON parsing.
export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  const m = /^sha256=([0-9a-f]{64})$/.exec(signatureHeader ?? '')
  if (!m) return false
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)))
  const claimed = m[1]!
  // Constant-time compare. Both sides are 32 bytes by construction.
  let diff = 0
  for (let i = 0; i < mac.length; i++) {
    diff |= mac[i]! ^ parseInt(claimed.slice(i * 2, i * 2 + 2), 16)
  }
  return diff === 0
}
