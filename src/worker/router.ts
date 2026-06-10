import type { Env } from './env.ts'

export type Handler = (
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  params: Record<string, string>,
) => Promise<Response> | Response

interface Route {
  method: string
  pattern: URLPattern
  handler: Handler
}

export class Router {
  private routes: Route[] = []

  on(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method,
      pattern: new URLPattern({ pathname: pattern }),
      handler,
    })
    return this
  }

  get(p: string, h: Handler) { return this.on('GET', p, h) }
  post(p: string, h: Handler) { return this.on('POST', p, h) }
  patch(p: string, h: Handler) { return this.on('PATCH', p, h) }
  delete(p: string, h: Handler) { return this.on('DELETE', p, h) }

  async handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    for (const r of this.routes) {
      if (r.method !== req.method) continue
      const match = r.pattern.exec(req.url)
      if (!match) continue
      const params: Record<string, string> = {}
      for (const [k, v] of Object.entries(match.pathname.groups)) {
        if (typeof v === 'string') params[k] = v
      }
      return r.handler(req, env, ctx, params)
    }
    return new Response('Not Found', { status: 404 })
  }
}
