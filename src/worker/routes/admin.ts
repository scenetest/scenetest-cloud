import type { Env } from '../env.ts'
import { getSessionUser, jsonUnauthorized } from '../auth/session.ts'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function readJson<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T } catch { return null }
}

const GH_HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'scenetest-cloud',
}

export async function listUsers(req: Request, env: Env): Promise<Response> {
  if (!(await getSessionUser(req, env))) return jsonUnauthorized()
  const rows = await env.DB.prepare(
    'SELECT github_id, github_login, added_at, added_by FROM allowed_user ORDER BY added_at ASC',
  ).all()
  return json({ users: rows.results ?? [] })
}

export async function addUser(req: Request, env: Env): Promise<Response> {
  const me = await getSessionUser(req, env)
  if (!me) return jsonUnauthorized()
  const body = await readJson<{ github_login?: string }>(req)
  const login = body?.github_login?.trim()
  if (!login) return json({ error: 'github_login required' }, 400)

  const resp = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: GH_HEADERS,
  })
  if (resp.status === 404) return json({ error: 'GitHub user not found' }, 404)
  if (!resp.ok) return json({ error: 'GitHub lookup failed' }, 502)
  const gh = (await resp.json()) as { id: number; login: string }

  await env.DB.prepare(
    `INSERT INTO allowed_user (github_id, github_login, added_at, added_by)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(github_id) DO UPDATE SET github_login = excluded.github_login`,
  )
    .bind(gh.id, gh.login, Date.now(), me.github_id)
    .run()
  return json({ github_id: gh.id, github_login: gh.login })
}

export async function deleteUser(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Record<string, string>,
): Promise<Response> {
  const me = await getSessionUser(req, env)
  if (!me) return jsonUnauthorized()
  const id = Number(params.github_id)
  if (!Number.isInteger(id)) return json({ error: 'bad github_id' }, 400)
  if (id === me.github_id) return json({ error: 'cannot remove yourself' }, 400)
  await env.DB.prepare('DELETE FROM allowed_user WHERE github_id = ?1').bind(id).run()
  return json({ ok: true })
}

export async function listRepos(req: Request, env: Env): Promise<Response> {
  if (!(await getSessionUser(req, env))) return jsonUnauthorized()
  const rows = await env.DB.prepare(
    `SELECT owner, name, github_repo_id, added_at, added_by
     FROM watched_repo ORDER BY owner, name`,
  ).all()
  return json({ repos: rows.results ?? [] })
}

export async function addRepo(req: Request, env: Env): Promise<Response> {
  const me = await getSessionUser(req, env)
  if (!me) return jsonUnauthorized()
  const body = await readJson<{ owner?: string; name?: string }>(req)
  const owner = body?.owner?.trim()
  const name = body?.name?.trim()
  if (!owner || !name) return json({ error: 'owner and name required' }, 400)

  const resp = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    { headers: GH_HEADERS },
  )
  if (resp.status === 404) return json({ error: 'GitHub repo not found' }, 404)
  if (!resp.ok) return json({ error: 'GitHub lookup failed' }, 502)
  const gh = (await resp.json()) as { id: number; owner: { login: string }; name: string }

  await env.DB.prepare(
    `INSERT INTO watched_repo (owner, name, github_repo_id, added_at, added_by)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(owner, name) DO UPDATE SET github_repo_id = excluded.github_repo_id`,
  )
    .bind(gh.owner.login, gh.name, gh.id, Date.now(), me.github_id)
    .run()
  return json({ owner: gh.owner.login, name: gh.name, github_repo_id: gh.id })
}

export async function deleteRepo(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: Record<string, string>,
): Promise<Response> {
  if (!(await getSessionUser(req, env))) return jsonUnauthorized()
  const owner = params.owner
  const name = params.name
  if (!owner || !name) return json({ error: 'bad path' }, 400)
  await env.DB.prepare('DELETE FROM watched_repo WHERE owner = ?1 AND name = ?2')
    .bind(owner, name)
    .run()
  return json({ ok: true })
}
