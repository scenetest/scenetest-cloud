import { describe, it, expect } from 'vitest'
import { decodeFrame } from './cloudTransport.ts'

// A viewer frame as the PR coordinator sends it: the log row's PR-global id and
// run_id around the payload it stored.
const frame = (id: number, runId: string, payload: Record<string, unknown>, seq = 1) =>
  JSON.stringify({ kind: 'event', id, runId, seq, payload: JSON.stringify(payload) })

const runStart = { type: 'run:start', timestamp: 1000, sceneCount: 2 }

describe('decodeFrame', () => {
  it('stamps the frame’s run id onto an event that names no run', () => {
    const decoded = decodeFrame(frame(7, 'run-abc', runStart), 0)
    expect(decoded).toEqual({ id: 7, event: { ...runStart, runId: 'run-abc' } })
  })

  // The cloud's run id is what the rest of the app means by "run" — the deep
  // link, the run picker, the archive — so it wins over the producer's own.
  it('overrides a producer’s run id with the frame’s', () => {
    const decoded = decodeFrame(frame(8, 'run-abc', { ...runStart, runId: '1000' }), 0)
    expect(decoded!.event.runId).toBe('run-abc')
  })

  it('drops a frame at or below the cursor', () => {
    expect(decodeFrame(frame(5, 'run-abc', runStart), 5)).toBeNull()
    expect(decodeFrame(frame(4, 'run-abc', runStart), 5)).toBeNull()
    expect(decodeFrame(frame(6, 'run-abc', runStart), 5)).not.toBeNull()
  })

  it('drops anything that is not an event frame', () => {
    expect(decodeFrame('not json', 0)).toBeNull()
    expect(decodeFrame(JSON.stringify({ kind: 'ack', runId: 'run-abc' }), 0)).toBeNull()
    expect(decodeFrame(JSON.stringify({ kind: 'event', runId: 'run-abc' }), 0)).toBeNull()
  })

  it('drops a frame whose payload is not an event', () => {
    expect(decodeFrame(frame(1, 'run-abc', { nope: true }), 0)).toBeNull()
    expect(decodeFrame(JSON.stringify({ kind: 'event', id: 1, runId: 'r', payload: '{' }), 0)).toBeNull()
  })

  // Guards the lenient check: swapping isEventShaped for isRunEvent would drop
  // every event this build predates, and every event of a pre-0.12 run.
  it('passes an unknown event type through, stamped', () => {
    const decoded = decodeFrame(frame(3, 'run-abc', { type: 'run:paused', timestamp: 2 }), 0)
    expect(decoded!.event).toEqual({ type: 'run:paused', timestamp: 2, runId: 'run-abc' })
  })

  it('leaves the event alone when the frame names no run', () => {
    const raw = JSON.stringify({ kind: 'event', id: 9, seq: 1, payload: JSON.stringify(runStart) })
    expect(decodeFrame(raw, 0)!.event).toEqual(runStart)
  })
})
