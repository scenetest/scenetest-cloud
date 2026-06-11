import type { Env } from './env.ts'
import { Router } from './router.ts'
import { dashboardHtml, dashboardRedirectToSlash, dashboardSse, dashboardNoop } from './scenetest-bridge/routes.ts'
import { postEvents, postSceneExecutions, postRunComplete } from './routes/runner-ingest.ts'
import { debugStubRun } from './routes/debug.ts'
import { postGithubWebhook } from './routes/webhook-github.ts'
import { reapRunners } from './runner/digitalocean.ts'
import {
  getGithubLogin,
  getGithubCallback,
  postLogout,
} from './auth/github-oauth.ts'
import {
  addRepo,
  addUser,
  deleteRepo,
  deleteUser,
  listRepos,
  listUsers,
} from './routes/admin.ts'
import { withSession } from './auth/session.ts'

// Auth is declared per route: withSession() for cookie-authed routes (json
// 401 or login redirect on failure); everything else is either public by
// design (/auth/*) or carries its own auth (bearer for runner ingest,
// env-gating for debug, HMAC for future webhooks).
const router = new Router()
  // Auth
  .get('/auth/github/login', getGithubLogin)
  .get('/auth/github/callback', getGithubCallback)
  .post('/auth/logout', postLogout)
  .get('/api/me', withSession((_req, _env, _ctx, _params, user) => Response.json(user)))
  // Admin
  .get('/api/admin/users', withSession(listUsers))
  .post('/api/admin/users', withSession(addUser))
  .delete('/api/admin/users/:github_id', withSession(deleteUser))
  .get('/api/admin/repos', withSession(listRepos))
  .post('/api/admin/repos', withSession(addRepo))
  .delete('/api/admin/repos/:owner/:name', withSession(deleteRepo))
  // Run dashboard (served by the scenetest bridge)
  .get('/r/:runId/dashboard', dashboardRedirectToSlash)
  .get('/r/:runId/dashboard/', withSession(dashboardHtml, 'redirect'))
  .get('/r/:runId/dashboard/__scenetest/events', withSession(dashboardSse))
  .post('/r/:runId/dashboard/__scenetest/:cmd', withSession(dashboardNoop))
  // GitHub webhooks (HMAC-authed inside the handler)
  .post('/webhook/github', postGithubWebhook)
  // Runner ingest (bearer-authed)
  .post('/api/events/:runId', postEvents)
  .post('/api/runs/:runId/scene-executions', postSceneExecutions)
  .post('/api/runs/:runId/complete', postRunComplete)
  // Debug (env-gated inside the handler)
  .post('/api/debug/stub-run', debugStubRun)

const REQUIRED_VARS = ['GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET', 'SESSION_SECRET'] as const

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const missing = REQUIRED_VARS.filter((k) => !env[k])
    if (missing.length > 0) {
      return new Response(
        `Missing config: ${missing.join(', ')}. Set in .dev.vars (local) or via wrangler vars/secrets.`,
        { status: 500 },
      )
    }

    try {
      const path = new URL(req.url).pathname
      if (
        path.startsWith('/api/') ||
        path.startsWith('/auth/') ||
        path.startsWith('/webhook/') ||
        path.startsWith('/r/')
      ) {
        return await router.handle(req, env, ctx)
      }
      // Everything else is the SPA shell — public. The SPA decides what to
      // render (signed-in vs not, 404s) client-side.
      return env.ASSETS.fetch(req)
    } catch (err) {
      const requestId = crypto.randomUUID()
      console.error(`[req ${requestId}]`, err instanceof Error ? err.stack ?? err.message : err)
      if (new URL(req.url).pathname.startsWith('/api/')) {
        return Response.json({ error: 'internal_error', requestId }, { status: 500 })
      }
      return new Response(`Internal error (request ${requestId})`, { status: 500 })
    }
  },

  // Cron (see wrangler.toml [triggers]): destroy droplets whose run ended or
  // whose age exceeds the cap. No-ops unless the DO provider is configured.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(reapRunners(env))
  },
}
