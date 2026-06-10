import type { Env } from '../env.ts'
import { getSessionUser, jsonUnauthorized } from '../auth/session.ts'

export async function getMe(req: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(req, env)
  if (!user) return jsonUnauthorized()
  return new Response(JSON.stringify(user), {
    headers: { 'content-type': 'application/json' },
  })
}
