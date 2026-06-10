import type { Env } from '../env.ts'
import type { Handler } from '../router.ts'
import type { AuthedHandler } from '../auth/session.ts'
import { renderDashboard } from './html.ts'

// The rewritten relative URLs ('./__scenetest/events') only resolve correctly
// when the page URL ends in a slash, so /r/:id/dashboard redirects to .../
export const dashboardRedirectToSlash: Handler = (req) => {
  const url = new URL(req.url)
  url.pathname += '/'
  return Response.redirect(url.toString(), 301)
}

export const dashboardHtml: AuthedHandler = () =>
  new Response(renderDashboard(), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

export const dashboardSse: AuthedHandler = (req, env, _ctx, params) =>
  streamRunEvents(req, env, params.runId!)

export const dashboardNoop: AuthedHandler = () => new Response(null, { status: 204 })

const POLL_MIN_MS = 250
const POLL_MAX_MS = 2000
const MAX_DURATION_MS = 5 * 60 * 1000
const TERMINAL = ['passed', 'failed', 'cancelled']

function streamRunEvents(req: Request, env: Env, runId: string): Response {
  const lastEventId = req.headers.get('last-event-id')
  let lastSeq = lastEventId ? parseInt(lastEventId, 10) : 0
  if (!Number.isFinite(lastSeq) || lastSeq < 0) lastSeq = 0

  const startedAt = Date.now()
  const encoder = new TextEncoder()
  let cancelled = false

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk))
      // Initial flush so the client knows we're alive.
      send(`: hello\n\n`)

      // One D1 round trip per tick: new events + run status together.
      const tick = async (): Promise<{ done: boolean; sawEvents: boolean }> => {
        const [events, run] = await env.DB.batch([
          env.DB.prepare(
            'SELECT seq, payload FROM events WHERE run_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT 500',
          ).bind(runId, lastSeq),
          env.DB.prepare('SELECT status FROM runs WHERE id = ?1').bind(runId),
        ])

        const rows = (events!.results ?? []) as Array<{ seq: number; payload: string }>
        for (const row of rows) {
          send(`id: ${row.seq}\ndata: ${row.payload}\n\n`)
          lastSeq = row.seq
        }

        const status = (run!.results?.[0] as { status: string } | undefined)?.status
        const terminal = status != null && TERMINAL.includes(status)
        return { done: terminal && rows.length === 0, sawEvents: rows.length > 0 }
      }

      try {
        let pollMs = POLL_MIN_MS
        while (!cancelled && !req.signal.aborted && Date.now() - startedAt < MAX_DURATION_MS) {
          const { done, sawEvents } = await tick()
          if (done) break
          // Back off while idle; snap back when events flow.
          pollMs = sawEvents ? POLL_MIN_MS : Math.min(pollMs * 2, POLL_MAX_MS)
          await new Promise((r) => setTimeout(r, pollMs))
        }
      } catch (err) {
        if (!cancelled) {
          send(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`)
        }
      }
      if (!cancelled) controller.close()
    },
    cancel() {
      // Client disconnected; stop the poll loop instead of letting it run out
      // the MAX_DURATION_MS clock against D1.
      cancelled = true
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  })
}
