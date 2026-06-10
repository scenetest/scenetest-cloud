// HMAC-signed cookie payloads. Cookie value layout:
//   <base64url(JSON payload)>.<base64url(HMAC-SHA-256(payload, SESSION_SECRET))>
// Verification is constant-time on the signature.

const enc = new TextEncoder()

function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of arr) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

// CryptoKey objects are immutable; cache across requests within the isolate
// instead of re-importing on every sign/verify.
let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null

function importHmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret !== secret) {
    cachedKey = {
      secret,
      key: crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      ),
    }
  }
  return cachedKey.key
}

function constantTimeEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export async function signPayload<T>(payload: T, secret: string): Promise<string> {
  const json = JSON.stringify(payload)
  const payloadB64 = b64urlEncode(enc.encode(json))
  const key = await importHmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64))
  return `${payloadB64}.${b64urlEncode(sig)}`
}

export async function verifyPayload<T>(token: string, secret: string): Promise<T | null> {
  const dot = token.indexOf('.')
  if (dot < 0) return null
  const payloadB64 = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)
  try {
    const key = await importHmacKey(secret)
    const expected = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64)),
    )
    const got = b64urlDecode(sigB64)
    if (!constantTimeEq(expected, got)) return null
    return JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as T
  } catch {
    return null
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

export function serializeCookie(
  name: string,
  value: string,
  opts: {
    maxAge?: number
    path?: string
    httpOnly?: boolean
    secure?: boolean
    sameSite?: 'Lax' | 'Strict' | 'None'
  } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`)
  parts.push(`Path=${opts.path ?? '/'}`)
  if (opts.httpOnly !== false) parts.push('HttpOnly')
  if (opts.secure) parts.push('Secure')
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`)
  return parts.join('; ')
}
