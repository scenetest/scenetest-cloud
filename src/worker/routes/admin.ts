import type { AuthedHandler } from '../auth/session.ts'
import { GH_API_HEADERS } from '../github.ts'

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
  const owner = body?.owner?.trim()
  const name = body?.name?.trim()
  if (!owner || !name) return Response.json({ error: 'owner and name required' }, { status: 400 })

  const resp = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    { headers: GH_API_HEADERS },
  )
  if (resp.status === 404) return Response.json({ error: 'GitHub repo not found' }, { status: 404 })
  if (!resp.ok) return Response.json({ error: 'GitHub lookup failed' }, { status: 502 })
  const gh = (await resp.json()) as { id: number; owner: { login: string }; name: string }

  await env.DB.prepare(
    `INSERT INTO watched_repo (owner, name, github_repo_id, added_at, added_by)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(owner, name) DO UPDATE SET github_repo_id = excluded.github_repo_id`,
  )
    .bind(gh.owner.login, gh.name, gh.id, Date.now(), me.github_id)
    .run()
  return Response.json({ owner: gh.owner.login, name: gh.name, github_repo_id: gh.id })
}

export const deleteRepo: AuthedHandler = async (_req, env, _ctx, params) => {
  await env.DB.prepare('DELETE FROM watched_repo WHERE owner = ?1 AND name = ?2')
    .bind(params.owner!, params.name!)
    .run()
  return Response.json({ ok: true })
}
