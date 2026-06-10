import type { Env } from '../env.ts'
import type { Handler } from '../router.ts'
import { renderDashboard } from './html.ts'

export const dashboardHtml: Handler = (req, _env, _ctx, params) => {
  const url = new URL(req.url)
  if (!url.pathname.endsWith('/')) {
    // The rewritten relative URLs ('./__scenetest/events') only resolve
    // correctly when the page URL ends in a slash.
    url.pathname += '/'
    return Response.redirect(url.toString(), 301)
  }
  if (!params.runId) return new Response('runId required', { status: 400 })
  return new Response(renderDashboard(), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

export const dashboardSse: Handler = (req, env, _ctx, params) => {
  const runId = params.runId
  if (!runId) return new Response('runId required', { status: 400 })
  return streamRunEvents(req, env, runId)
}

export const dashboardNoop: Handler = () => new Response(null, { status: 204 })

const POLL_MS = 250
const MAX_DURATION_MS = 5 * 60 * 1000

function streamRunEvents(req: Request, env: Env, runId: string): Response {
  const lastEventId = req.headers.get('last-event-id')
  let lastSeq = lastEventId ? parseInt(lastEventId, 10) : 0
  if (!Number.isFinite(lastSeq) || lastSeq < 0) lastSeq = 0

  const startedAt = Date.now()
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk))
      // Initial flush so the client knows we're alive.
      send(`: hello\n\n`)

      const tick = async (): Promise<boolean> => {
        const rows = await env.DB.prepare(
          'SELECT seq, payload FROM events WHERE run_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT 500',
        )
          .bind(runId, lastSeq)
          .all<{ seq: number; payload: string }>()

        for (const row of rows.results ?? []) {
          send(`id: ${row.seq}\ndata: ${row.payload}\n\n`)
          lastSeq = row.seq
        }

        const runRow = await env.DB.prepare(
          'SELECT status FROM runs WHERE id = ?1',
        )
          .bind(runId)
          .first<{ status: string }>()
        const terminal = runRow && ['passed', 'failed', 'cancelled'].includes(runRow.status)
        return Boolean(terminal && (rows.results?.length ?? 0) === 0)
      }

      try {
        while (Date.now() - startedAt < MAX_DURATION_MS) {
          const done = await tick()
          if (done) break
          await new Promise((r) => setTimeout(r, POLL_MS))
        }
      } catch (err) {
        send(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`)
      }
      controller.close()
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
