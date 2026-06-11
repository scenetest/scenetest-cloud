import type { Env } from '../env.ts'

const enc = new TextEncoder()

export async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(token))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface BearerRun {
  repo: string
  pr_number: number
  head_sha: string
}

// Verifies the box's bearer token for an ingest request scoped to a run. The
// credential belongs to the run's box (one per PR), so we join run → box;
// returning the run's repo/pr/sha also saves ingest handlers a re-query.
export async function verifyBoxToken(
  req: Request,
  env: Env,
  runId: string,
): Promise<{ ok: true; run: BearerRun } | { ok: false; response: Response }> {
  const auth = req.headers.get('authorization') ?? ''
  const m = /^Bearer\s+(.+)$/.exec(auth)
  if (!m || !m[1]) {
    return { ok: false, response: new Response('Unauthorized', { status: 401 }) }
  }
  const row = await env.DB.prepare(
    `SELECT b.bearer_token_hash AS bearer_token_hash, r.repo, r.pr_number, r.head_sha
       FROM runs r JOIN boxes b ON b.id = r.box_id
     WHERE r.id = ?1`,
  )
    .bind(runId)
    .first<BearerRun & { bearer_token_hash: string }>()
  if (!row) return { ok: false, response: new Response('Run not found', { status: 404 }) }
  // Comparing two SHA-256 digests: timing leaks nothing about the token
  // preimage, so plain equality is fine here.
  if ((await hashToken(m[1])) !== row.bearer_token_hash) {
    return { ok: false, response: new Response('Unauthorized', { status: 401 }) }
  }
  return { ok: true, run: { repo: row.repo, pr_number: row.pr_number, head_sha: row.head_sha } }
}
