import type { Env } from './env.ts'
import { Router } from './router.ts'
import { dashboardHtml, dashboardSse, dashboardNoop } from './scenetest-bridge/routes.ts'
import { postEvents, postSceneExecutions, postRunComplete } from './routes/runner-ingest.ts'
import { debugStubRun } from './routes/debug.ts'
import {
  getGithubLogin,
  getGithubCallback,
  postLogout,
} from './auth/github-oauth.ts'
import { getMe } from './routes/me.ts'
import {
  addRepo,
  addUser,
  deleteRepo,
  deleteUser,
  listRepos,
  listUsers,
} from './routes/admin.ts'
import {
  getSessionUser,
  jsonUnauthorized,
  redirectToLogin,
} from './auth/session.ts'

const router = new Router()
  // Auth
  .get('/auth/github/login', getGithubLogin)
  .get('/auth/github/callback', getGithubCallback)
  .post('/auth/logout', postLogout)
  .get('/api/me', getMe)
  // Admin (session-gated inside the handlers)
  .get('/api/admin/users', listUsers)
  .post('/api/admin/users', addUser)
  .delete('/api/admin/users/:github_id', deleteUser)
  .get('/api/admin/repos', listRepos)
  .post('/api/admin/repos', addRepo)
  .delete('/api/admin/repos/:owner/:name', deleteRepo)
  // Runner-facing dashboard (session-gated inside the handler / scenetest-bridge)
  .get('/r/:runId/dashboard', dashboardHtml)
  .get('/r/:runId/dashboard/', dashboardHtml)
  .get('/r/:runId/dashboard/__scenetest/events', dashboardSse)
  .post('/r/:runId/dashboard/__scenetest/replay', dashboardNoop)
  .post('/r/:runId/dashboard/__scenetest/stop', dashboardNoop)
  .post('/r/:runId/dashboard/__scenetest/pause', dashboardNoop)
  // Runner ingest (bearer-authed)
  .post('/api/events/:runId', postEvents)
  .post('/api/runs/:runId/scene-executions', postSceneExecutions)
  .post('/api/runs/:runId/complete', postRunComplete)
  // Debug
  .post('/api/debug/stub-run', debugStubRun)

// Paths that don't need a session cookie. Either anonymous by design
// (/auth/*) or carry their own auth (bearer for runner ingest, HMAC for
// webhooks, env-gated for debug).
function isPublicPath(pathname: string): boolean {
  if (pathname.startsWith('/auth/')) return true
  if (pathname.startsWith('/webhook/')) return true
  if (pathname.startsWith('/api/events/')) return true
  if (pathname.startsWith('/api/debug/')) return true
  // POST /api/runs/:runId/scene-executions and /complete
  if (/^\/api\/runs\/[^/]+\/(scene-executions|complete)$/.test(pathname)) return true
  return false
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    if (!isPublicPath(path)) {
      const user = await getSessionUser(req, env)
      if (!user) {
        const isApi = path.startsWith('/api/')
        return isApi ? jsonUnauthorized() : redirectToLogin(req)
      }
    }

    if (
      path.startsWith('/api/') ||
      path.startsWith('/webhook/') ||
      path.startsWith('/auth/') ||
      path.startsWith('/r/')
    ) {
      return router.handle(req, env, ctx)
    }

    return env.ASSETS.fetch(req)
  },
}
