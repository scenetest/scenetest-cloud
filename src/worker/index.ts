import type { Env } from './env.ts'
import { Router } from './router.ts'
import { dashboardHtml, dashboardSse, dashboardNoop } from './scenetest-bridge/routes.ts'
import { postEvents, postSceneExecutions, postRunComplete } from './routes/runner-ingest.ts'
import { debugStubRun } from './routes/debug.ts'

const router = new Router()
  .get('/r/:runId/dashboard', dashboardHtml)
  .get('/r/:runId/dashboard/', dashboardHtml)
  .get('/r/:runId/dashboard/__scenetest/events', dashboardSse)
  .post('/r/:runId/dashboard/__scenetest/replay', dashboardNoop)
  .post('/r/:runId/dashboard/__scenetest/stop', dashboardNoop)
  .post('/r/:runId/dashboard/__scenetest/pause', dashboardNoop)
  .post('/api/events/:runId', postEvents)
  .post('/api/runs/:runId/scene-executions', postSceneExecutions)
  .post('/api/runs/:runId/complete', postRunComplete)
  .post('/api/debug/stub-run', debugStubRun)

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url)

    if (
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/webhook/') ||
      url.pathname.startsWith('/auth/') ||
      url.pathname.startsWith('/r/')
    ) {
      return router.handle(req, env, ctx)
    }

    return env.ASSETS.fetch(req)
  },
}
