import type { AuthedHandler } from '../auth/session.ts'
import { GH_API_HEADERS, ghHeaders } from '../github.ts'

async function readJson<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T } catch { return null }
}

export const listUsers: AuthedHandler = async (_req, env) => {
  const rows = await env.DB.prepare(
    'SELECT github_id, github_login, added_at, added_by FROM allowed_user ORDER BY added_at ASC',
  ).all()
  return Response.json({ users: rows.results ?? [] })
}

export const addUser: AuthedHandler = async (req, env, _ctx, _params, me) => {
  const body = await readJson<{ github_login?: string }>(req)
  const login = body?.github_login?.trim()
  if (!login) return Response.json({ error: 'github_login required' }, { status: 400 })

  const resp = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: GH_API_HEADERS,
  })
  if (resp.status === 404) return Response.json({ error: 'GitHub user not found' }, { status: 404 })
  if (!resp.ok) return Response.json({ error: 'GitHub lookup failed' }, { status: 502 })
  const gh = (await resp.json()) as { id: number; login: string }

  await env.DB.prepare(
    `INSERT INTO allowed_user (github_id, github_login, added_at, added_by)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(github_id) DO UPDATE SET github_login = excluded.github_login`,
  )
    .bind(gh.id, gh.login, Date.now(), me.github_id)
    .run()
  return Response.json({ github_id: gh.id, github_login: gh.login })
}

export const deleteUser: AuthedHandler = async (_req, env, _ctx, params, me) => {
  const id = Number(params.github_id)
  if (!Number.isInteger(id)) return Response.json({ error: 'bad github_id' }, { status: 400 })
  if (id === me.github_id) return Response.json({ error: 'cannot remove yourself' }, { status: 400 })
  await env.DB.prepare('DELETE FROM allowed_user WHERE github_id = ?1').bind(id).run()
  return Response.json({ ok: true })
}

export const listRepos: AuthedHandler = async (_req, env) => {
  const rows = await env.DB.prepare(
    `SELECT owner, name, github_repo_id, added_at, added_by
     FROM watched_repo ORDER BY owner, name`,
  ).all()
  return Response.json({ repos: rows.results ?? [] })
}

export const addRepo: AuthedHandler = async (req, env, _ctx, _params, me) => {
  const body = await readJson<{ owner?: string; name?: string }>(req)
  let owner = body?.owner?.trim()
  let name = body?.name?.trim()
  if (!owner || !name) return Response.json({ error: 'owner and name required' }, { status: 400 })

  // The GitHub lookup is enrichment, not a gate. Unauthenticated
  // api.github.com calls from a Worker share an egress IP and hit the 60/hr
  // rate limit (403) constantly, and private repos 404 to unauthenticated
  // requests — neither should stop you watching your own repo. On success we
  // adopt GitHub's canonical casing and repo id; otherwise we trust the
  // input. Webhook delivery is matched case-insensitively on owner/name and
  // gated by HMAC regardless, so an unverified or mistyped row is harmless.
  let githubRepoId: number | null = null
  let verified = false
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      { headers: GH_API_HEADERS },
    )
    if (resp.ok) {
      const gh = (await resp.json()) as { id: number; owner: { login: string }; name: string }
      owner = gh.owner.login
      name = gh.name
      githubRepoId = gh.id
      verified = true
    } else {
      console.warn(`addRepo: GitHub lookup for ${owner}/${name} returned ${resp.status}; watching unverified`)
    }
  } catch (err) {
    console.warn(`addRepo: GitHub lookup for ${owner}/${name} failed: ${err instanceof Error ? err.message : err}`)
  }

  await env.DB.prepare(
    `INSERT INTO watched_repo (owner, name, github_repo_id, added_at, added_by)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(owner, name) DO UPDATE SET
       github_repo_id = COALESCE(excluded.github_repo_id, watched_repo.github_repo_id)`,
  )
    .bind(owner, name, githubRepoId, Date.now(), me.github_id)
    .run()
  return Response.json({ owner, name, github_repo_id: githubRepoId, verified })
}

export const deleteRepo: AuthedHandler = async (_req, env, _ctx, params) => {
  await env.DB.prepare('DELETE FROM watched_repo WHERE owner = ?1 AND name = ?2')
    .bind(params.owner!, params.name!)
    .run()
  return Response.json({ ok: true })
}

// GET /api/admin/repos/:owner/:name/status — the add-a-project wizard's
// live checklist (docs/add-a-project.md). Each phase reports from evidence
// the system already has:
//   registered — the watched_repo row exists
//   webhook    — any delivery recorded for this repo (GitHub's creation
//                ping counts, which is exactly why pings record their repo)
//   pipeline   — 'active' when the latest box realized real stages,
//                'absent' when it realized only the coarse default,
//                else a direct GitHub contents probe ('present'/'absent'),
//                'unknown' when GitHub can't be reached
//   first_run  — the most recent run, if any
const PROBE_TTL_MS = 60_000
const probeCache = new Map<string, { at: number; state: 'present' | 'absent' }>()

export const repoStatus: AuthedHandler = async (_req, env, _ctx, params) => {
  const owner = params.owner!
  const name = params.name!
  const repo = `${owner}/${name}`

  const [registered, delivery, box, run] = await Promise.all([
    env.DB.prepare(
      'SELECT 1 FROM watched_repo WHERE owner = ?1 COLLATE NOCASE AND name = ?2 COLLATE NOCASE',
    ).bind(owner, name).first(),
    env.DB.prepare(
      `SELECT event, received_at FROM webhook_deliveries
        WHERE repo = ?1 COLLATE NOCASE ORDER BY received_at DESC LIMIT 1`,
    ).bind(repo).first<{ event: string; received_at: number }>(),
    env.DB.prepare(
      `SELECT realized_stages FROM boxes WHERE repo = ?1 COLLATE NOCASE
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).bind(repo).first<{ realized_stages: string | null }>(),
    env.DB.prepare(
      `SELECT id, status, started_at FROM runs WHERE repo = ?1 COLLATE NOCASE
        ORDER BY rowid DESC LIMIT 1`,
    ).bind(repo).first<{ id: string; status: string; started_at: number | null }>(),
  ])

  let pipeline: { state: 'active' | 'present' | 'absent' | 'unknown'; source: 'box' | 'github' }
  const realizedKeys = box?.realized_stages ? Object.keys(JSON.parse(box.realized_stages)) : null
  if (realizedKeys && realizedKeys.length > 0) {
    // A box has run the pipeline. System pseudo-stages ('*setup*' from the
    // default pipeline, '*coarse*' from the fallback plan) live in a
    // reserved namespace user stage names can't enter — all-reserved means
    // no real pipeline file was in play.
    const coarse = realizedKeys.every((k) => k.startsWith('*'))
    pipeline = { state: coarse ? 'absent' : 'active', source: 'box' }
  } else {
    pipeline = { state: 'unknown', source: 'github' }
    // The wizard polls this endpoint every few seconds; cache the GitHub
    // probe per repo so polling doesn't burn the rate limit (isolate-local,
    // best effort).
    const cacheKey = `${owner}/${name}`.toLowerCase()
    const cached = probeCache.get(cacheKey)
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
      pipeline = { state: cached.state, source: 'github' }
    } else {
      try {
        const resp = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/scenetest/pipeline.json`,
          { headers: ghHeaders(env) },
        )
        if (resp.ok || resp.status === 404) {
          const state = resp.ok ? ('present' as const) : ('absent' as const)
          probeCache.set(cacheKey, { at: Date.now(), state })
          pipeline = { state, source: 'github' }
        }
      } catch {
        // network/rate-limit: stay 'unknown'
      }
    }
  }

  return Response.json({
    registered: registered !== null,
    webhook: delivery
      ? { seen: true, last_event: delivery.event, last_at: delivery.received_at }
      : { seen: false },
    pipeline,
    first_run: run ?? null,
  })
}
