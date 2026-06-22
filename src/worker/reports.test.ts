import { describe, expect, it } from 'vitest'
import {
  buildReportComparison,
  issueFingerprint,
  reportHashes,
  type IssueRow,
  type MetricRow,
  type SummaryRow,
} from './reports.ts'

const metric = (input_hash: string, stage: string, name: string, value: number, unit: string | null = null): MetricRow =>
  ({ stage, input_hash, name, value, unit })
const issueRow = (
  input_hash: string,
  stage: string,
  kind: string,
  o: Partial<IssueRow> & { message: string },
): IssueRow => ({
  stage,
  input_hash,
  kind,
  fingerprint: issueFingerprint(kind, { file: o.file ?? undefined, line: o.line ?? undefined, message: o.message }),
  file: o.file ?? null,
  line: o.line ?? null,
  col: o.col ?? null,
  severity: o.severity ?? null,
  message: o.message,
  raw: o.raw ?? null,
})

describe('issueFingerprint', () => {
  it('is stable for the same identifying fields and distinct otherwise', () => {
    const a = issueFingerprint('lint', { file: 'a.ts', line: 1, message: 'x' })
    expect(a).toBe(issueFingerprint('lint', { file: 'a.ts', line: 1, message: 'x', severity: 'warning' }))
    expect(a).not.toBe(issueFingerprint('lint', { file: 'a.ts', line: 2, message: 'x' }))
    expect(a).not.toBe(issueFingerprint('typecheck', { file: 'a.ts', line: 1, message: 'x' }))
  })
})

describe('buildReportComparison — metrics', () => {
  it('pairs base and head values by (stage, name) and computes the delta', () => {
    const head = { build: 'h1' }
    const base = { build: 'b1' }
    const rows = {
      metrics: [
        metric('b1', 'build', 'bundle.raw', 1000, 'bytes'),
        metric('h1', 'build', 'bundle.raw', 1200, 'bytes'),
      ],
      summaries: [],
      issues: [],
    }
    const c = buildReportComparison(head, base, rows)
    expect(c.baseMissing).toBe(false)
    expect(c.metrics).toEqual([
      { stage: 'build', name: 'bundle.raw', unit: 'bytes', base: 1000, head: 1200, delta: 200 },
    ])
  })

  it('leaves delta null when one side is missing', () => {
    const c = buildReportComparison({ build: 'h1' }, { build: 'b1' }, {
      metrics: [metric('h1', 'build', 'bundle.gzip', 400)],
      summaries: [],
      issues: [],
    })
    expect(c.metrics[0]).toMatchObject({ base: null, head: 400, delta: null })
  })

  it('treats an unchanged stage (base hash == head hash) as head, no delta', () => {
    // A stage that did not change has the same input hash on both sides; its one
    // report row counts as head and base stays null (no spurious delta).
    const c = buildReportComparison({ build: 'same' }, { build: 'same' }, {
      metrics: [metric('same', 'build', 'bundle.raw', 999, 'bytes')],
      summaries: [],
      issues: [],
    })
    expect(c.metrics[0]).toMatchObject({ base: null, head: 999, delta: null })
  })
})

describe('buildReportComparison — issues', () => {
  it('diffs head against base into added / resolved / unchanged', () => {
    const head = { build: 'h1' }
    const base = { build: 'b1' }
    const rows = {
      metrics: [],
      summaries: [],
      issues: [
        // persists across both → unchanged
        issueRow('b1', 'build', 'lint', { file: 'a.ts', line: 1, message: 'no-unused' }),
        issueRow('h1', 'build', 'lint', { file: 'a.ts', line: 1, message: 'no-unused' }),
        // only at base → resolved
        issueRow('b1', 'build', 'lint', { file: 'b.ts', line: 5, message: 'no-console' }),
        // only at head → added (regression)
        issueRow('h1', 'build', 'lint', { file: 'c.ts', line: 9, message: 'no-debugger' }),
      ],
    }
    const c = buildReportComparison(head, base, rows)
    const block = c.issues.find((i) => i.stage === 'build' && i.kind === 'lint')!
    expect(block.unchanged).toBe(1)
    expect(block.moved).toBe(0)
    expect(block.added.map((i) => i.message)).toEqual(['no-debugger'])
    expect(block.resolved.map((i) => i.message)).toEqual(['no-console'])
  })

  it('treats a line-shifted issue (same file/col/message, ±10) as moved, not new/resolved', () => {
    const c = buildReportComparison({ build: 'h1' }, { build: 'b1' }, {
      metrics: [],
      summaries: [],
      issues: [
        issueRow('b1', 'build', 'lint', { file: 'a.ts', col: 3, line: 5, message: 'no-console' }),
        issueRow('h1', 'build', 'lint', { file: 'a.ts', col: 3, line: 12, message: 'no-console' }), // +7 lines
      ],
    })
    const block = c.issues[0]!
    expect(block.moved).toBe(1)
    expect(block.added).toHaveLength(0)
    expect(block.resolved).toHaveLength(0)
  })

  it('a shift beyond proximity is a genuine new + resolved pair', () => {
    const c = buildReportComparison({ build: 'h1' }, { build: 'b1' }, {
      metrics: [],
      summaries: [],
      issues: [
        issueRow('b1', 'build', 'lint', { file: 'a.ts', col: 3, line: 5, message: 'no-console' }),
        issueRow('h1', 'build', 'lint', { file: 'a.ts', col: 3, line: 40, message: 'no-console' }), // +35 lines
      ],
    })
    const block = c.issues[0]!
    expect(block.moved).toBe(0)
    expect(block.added).toHaveLength(1)
    expect(block.resolved).toHaveLength(1)
  })

  it('a changed column is fair game — not treated as a shift', () => {
    const c = buildReportComparison({ build: 'h1' }, { build: 'b1' }, {
      metrics: [],
      summaries: [],
      issues: [
        issueRow('b1', 'build', 'lint', { file: 'a.ts', col: 3, line: 5, message: 'no-console' }),
        issueRow('h1', 'build', 'lint', { file: 'a.ts', col: 9, line: 6, message: 'no-console' }), // col moved
      ],
    })
    const block = c.issues[0]!
    expect(block.moved).toBe(0)
    expect(block.added).toHaveLength(1)
    expect(block.resolved).toHaveLength(1)
  })

  it('with no base vector, every issue is added and baseMissing is true', () => {
    const c = buildReportComparison({ build: 'h1' }, null, {
      metrics: [],
      summaries: [],
      issues: [issueRow('h1', 'build', 'typecheck', { file: 'a.ts', line: 1, message: 'TS2304' })],
    })
    expect(c.baseMissing).toBe(true)
    const block = c.issues[0]!
    expect(block.added).toHaveLength(1)
    expect(block.resolved).toHaveLength(0)
  })
})

describe('buildReportComparison — summaries', () => {
  it('parses and pairs summary blobs by (stage, kind)', () => {
    const rows = {
      metrics: [],
      summaries: [
        { stage: 'build', input_hash: 'b1', kind: 'lint', summary_json: '{"errors":3}' } as SummaryRow,
        { stage: 'build', input_hash: 'h1', kind: 'lint', summary_json: '{"errors":1}' } as SummaryRow,
      ],
      issues: [],
    }
    const c = buildReportComparison({ build: 'h1' }, { build: 'b1' }, rows)
    expect(c.summaries[0]).toEqual({ stage: 'build', kind: 'lint', base: { errors: 3 }, head: { errors: 1 } })
  })
})

describe('reportHashes', () => {
  it('returns the deduped union of head and base stage hashes', () => {
    const hashes = reportHashes({ build: 'h1', deps: 'd1' }, { build: 'b1', deps: 'd1' })
    expect(hashes).toContainEqual({ stage: 'build', hash: 'h1' })
    expect(hashes).toContainEqual({ stage: 'build', hash: 'b1' })
    // deps shares one hash on both sides → present once
    expect(hashes.filter((h) => h.stage === 'deps')).toEqual([{ stage: 'deps', hash: 'd1' }])
  })
})
