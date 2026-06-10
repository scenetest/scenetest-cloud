import type { Env } from '../env.ts'

const enc = new TextEncoder()

export async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(token))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function verifyRunBearer(
  req: Request,
  env: Env,
  runId: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const auth = req.headers.get('authorization') ?? ''
  const m = /^Bearer\s+(.+)$/.exec(auth)
  if (!m || !m[1]) {
    return { ok: false, response: new Response('Unauthorized', { status: 401 }) }
  }
  const expected = await env.DB.prepare('SELECT bearer_token_hash FROM runs WHERE id = ?1')
    .bind(runId)
    .first<{ bearer_token_hash: string }>()
  if (!expected) return { ok: false, response: new Response('Run not found', { status: 404 }) }
  const provided = await hashToken(m[1])
  if (!constantTimeEq(provided, expected.bearer_token_hash)) {
    return { ok: false, response: new Response('Unauthorized', { status: 401 }) }
  }
  return { ok: true }
}
