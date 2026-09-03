import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../env.ts'
import { devOnly } from './dev-only.ts'

const ok = () => new Response('ran')

function call(gate: string | undefined, handler = vi.fn(ok)) {
  const req = new Request('https://example.com/api/debug/stub-run', { method: 'POST' })
  return {
    handler,
    res: devOnly(handler)(req, { ENABLE_DEBUG_ROUTES: gate } as Env, {} as ExecutionContext, {}),
  }
}

describe('devOnly', () => {
  it('is 404 without the switch — the deployed default', async () => {
    for (const gate of [undefined, '0', 'true', '1 ']) {
      const { handler, res } = call(gate)
      expect((await res).status).toBe(404)
      expect(handler).not.toHaveBeenCalled()
    }
  })

  it('runs the handler when the switch is on', async () => {
    const { handler, res } = call('1')
    expect(await (await res).text()).toBe('ran')
    expect(handler).toHaveBeenCalledOnce()
  })
})
