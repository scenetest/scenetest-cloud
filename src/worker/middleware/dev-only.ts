import { devRoutesEnabled, type Env } from '../env.ts'
import type { Handler } from '../router.ts'

// Declares a route as dev-only at the route table, the way withSession()
// declares cookie auth: without the switch the route does not exist, and the
// 404 is identical to an unregistered path. Wrapping at registration is what
// makes "these routes cannot be reached in production" readable in one place
// — a gate written inside a handler is invisible to anyone reading the table,
// and absent from the next handler somebody adds.
export function devOnly(handler: Handler): Handler {
  return (req, env: Env, ctx, params) =>
    devRoutesEnabled(env) ? handler(req, env, ctx, params) : new Response('Not Found', { status: 404 })
}
