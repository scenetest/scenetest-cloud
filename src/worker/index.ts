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
  // Runner-facing dashboard
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

// /api/* paths that don't need a session cookie. Either anonymous by design
// or carry their own auth (bearer for runner ingest, env-gated for debug).
function isPublicApiPath(pathname: string): boolean {
  if (pathname === '/api/me') return true                    // handler returns 401
  if (pathname.startsWith('/api/events/')) return true       // bearer-authed
  if (pathname.startsWith('/api/debug/')) return true        // env-gated
  return /^\/api\/runs\/[^/]+\/(scene-executions|complete)$/.test(pathname)
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname

  // Webhooks carry their own HMAC auth; pass straight to the router.
  if (path.startsWith('/webhook/') || path.startsWith('/auth/')) {
    return router.handle(req, env, ctx)
  }

  // API: 401 JSON when the route requires a session.
  if (path.startsWith('/api/')) {
    if (!isPublicApiPath(path) && !(await getSessionUser(req, env))) {
      return jsonUnauthorized()
    }
    return router.handle(req, env, ctx)
  }

  // Run dashboard: gate at the edge with a redirect to login.
  if (path.startsWith('/r/')) {
    if (!(await getSessionUser(req, env))) return redirectToLogin(req)
    return router.handle(req, env, ctx)
  }

  // Everything else is the SPA shell — public. The SPA decides what to render
  // (signed-in vs not, /404 for unknown routes) by calling /api/me + reading
  // window.location.pathname.
  return env.ASSETS.fetch(req)
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(req, env, ctx)
    } catch (err) {
      const requestId = crypto.randomUUID()
      console.error(`[req ${requestId}]`, err instanceof Error ? err.stack ?? err.message : err)
      const wantsJson = new URL(req.url).pathname.startsWith('/api/')
      if (wantsJson) {
        return new Response(JSON.stringify({ error: 'internal_error', requestId }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(`Internal error (request ${requestId})`, {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      })
    }
  },
}
