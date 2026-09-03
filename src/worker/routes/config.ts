import { devRoutesEnabled } from '../env.ts'
import type { Handler } from '../router.ts'

// GET /api/config — public, unauthenticated: it is what the signed-out screen
// reads before it has a session. Only advertises which sign-in routes exist,
// never anything about the deployment's secrets.
export const getConfig: Handler = (_req, env) => Response.json({ dev_auth: devRoutesEnabled(env) })
