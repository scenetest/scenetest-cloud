import { describe, expect, it } from 'vitest'
import { parseReport } from './report-adapters.ts'

describe('loc adapter', () => {
  it('aggregates per-file line counts into total + files metrics', () => {
    const raw = JSON.stringify({ files: [{ path: 'a.ts', lines: 10 }, { path: 'b.ts', lines: 5 }] })
    const items = parseReport('loc', raw)
    expect(items).toContainEqual({ type: 'metric', name: 'loc.total', value: 15, unit: 'lines' })
    expect(items).toContainEqual({ type: 'metric', name: 'loc.files', value: 2, unit: 'count' })
    expect(items).toContainEqual({ type: 'summary', kind: 'loc', summary: { total: 15, files: 2 } })
  })

  it('handles an empty file set', () => {
    const items = parseReport('loc', '{"files":[]}')
    expect(items).toContainEqual({ type: 'metric', name: 'loc.total', value: 0, unit: 'lines' })
  })
})

describe('lint adapter (eslint -f json shape)', () => {
  const eslint = JSON.stringify([
    {
      filePath: '/box/work/repo/src/a.ts',
      messages: [
        { ruleId: 'no-debugger', severity: 2, line: 9, column: 1, message: 'Unexpected debugger.' },
        { ruleId: 'no-unused-vars', severity: 1, line: 1, column: 7, message: 'x is unused.' },
      ],
    },
  ])

  it('parses issues, counts errors/warnings, relativizes paths against root', () => {
    const items = parseReport('lint', eslint, { root: '/box/work/repo' })
    const issues = items.find((i) => i.type === 'issues')!
    expect(issues).toMatchObject({
      kind: 'lint',
      issues: [
        { file: 'src/a.ts', line: 9, col: 1, severity: 'error', message: 'Unexpected debugger.', raw: 'no-debugger' },
        { file: 'src/a.ts', line: 1, col: 7, severity: 'warning', message: 'x is unused.', raw: 'no-unused-vars' },
      ],
    })
    expect(items).toContainEqual({ type: 'summary', kind: 'lint', summary: { errors: 1, warnings: 1 } })
    expect(items).toContainEqual({ type: 'metric', name: 'lint.errors', value: 1, unit: 'count' })
    expect(items).toContainEqual({ type: 'metric', name: 'lint.warnings', value: 1, unit: 'count' })
  })

  it('treats empty output as a clean report (no issues, zero counts)', () => {
    const items = parseReport('lint', '', {})
    expect(items.find((i) => i.type === 'issues')).toMatchObject({ issues: [] })
    expect(items).toContainEqual({ type: 'summary', kind: 'lint', summary: { errors: 0, warnings: 0 } })
  })

  it('accepts a flat diagnostics array (oxlint-style)', () => {
    const flat = JSON.stringify([
      { filename: 'src/b.ts', line: 3, column: 2, severity: 'error', message: 'bad', ruleId: 'rule-x' },
    ])
    const items = parseReport('lint', flat, {})
    expect(items.find((i) => i.type === 'issues')).toMatchObject({
      issues: [{ file: 'src/b.ts', line: 3, col: 2, severity: 'error', message: 'bad', raw: 'rule-x' }],
    })
  })

  it('parses real oxlint --format=json output (miette diagnostics)', () => {
    // Captured verbatim from `oxlint --format=json` (v1.x): a top-level object
    // with a `diagnostics` array; line/column live in labels[].span, the rule
    // in `code`, severity as a string.
    const oxlint = JSON.stringify({
      diagnostics: [
        {
          message: '`debugger` statement is not allowed',
          code: 'eslint(no-debugger)',
          severity: 'warning',
          filename: '/box/repo/bad.ts',
          labels: [{ span: { offset: 26, length: 8, line: 2, column: 3 } }],
        },
        {
          message: "Variable 'y' is declared but never used.",
          code: 'eslint(no-unused-vars)',
          severity: 'error',
          filename: '/box/repo/bad.ts',
          labels: [{ label: "'y' is declared here", span: { offset: 61, length: 1, line: 4, column: 7 } }],
        },
      ],
      number_of_files: 1,
      number_of_rules: 95,
    })
    const items = parseReport('lint', oxlint, { root: '/box/repo' })
    const issues = items.find((i) => i.type === 'issues')!
    expect(issues).toMatchObject({
      kind: 'lint',
      issues: [
        { file: 'bad.ts', line: 2, col: 3, severity: 'warning', message: '`debugger` statement is not allowed', raw: 'eslint(no-debugger)' },
        { file: 'bad.ts', line: 4, col: 7, severity: 'error', message: "Variable 'y' is declared but never used.", raw: 'eslint(no-unused-vars)' },
      ],
    })
    expect(items).toContainEqual({ type: 'summary', kind: 'lint', summary: { errors: 1, warnings: 1 } })
  })

  it('records an error summary on unparseable output rather than throwing', () => {
    const items = parseReport('lint', 'not json at all', {})
    expect(items).toEqual([{ type: 'summary', kind: 'lint', summary: { error: 'unparseable report output' } }])
  })
})

describe('typecheck adapter (tsc default output)', () => {
  it('parses file(line,col): error TS####: message lines and ignores the rest', () => {
    const tsc = [
      'src/a.ts(12,5): error TS2304: Cannot find name \'foo\'.',
      'src/b.ts(3,10): error TS2532: Object is possibly \'undefined\'.',
      '',
      'Found 2 errors in 2 files.',
      '',
      'Errors  Files',
    ].join('\n')
    const items = parseReport('typecheck', tsc)
    const issues = items.find((i) => i.type === 'issues')!
    expect(issues).toMatchObject({
      kind: 'typecheck',
      issues: [
        { file: 'src/a.ts', line: 12, col: 5, severity: 'error', message: "TS2304: Cannot find name 'foo'.", raw: 'TS2304' },
        { file: 'src/b.ts', line: 3, col: 10, severity: 'error', message: "TS2532: Object is possibly 'undefined'.", raw: 'TS2532' },
      ],
    })
    expect(items).toContainEqual({ type: 'summary', kind: 'typecheck', summary: { errors: 2, warnings: 0 } })
    expect(items).toContainEqual({ type: 'metric', name: 'typecheck.errors', value: 2, unit: 'count' })
  })

  it('relativizes absolute paths against root', () => {
    const items = parseReport('typecheck', '/box/repo/src/x.ts(1,1): error TS1005: \';\' expected.', { root: '/box/repo' })
    expect(items.find((i) => i.type === 'issues')).toMatchObject({ issues: [{ file: 'src/x.ts' }] })
  })

  it('a clean run (no diagnostic lines) is zero errors', () => {
    const items = parseReport('typecheck', '\n')
    expect(items).toContainEqual({ type: 'summary', kind: 'typecheck', summary: { errors: 0, warnings: 0 } })
  })
})

describe('bundle adapter', () => {
  const raw = JSON.stringify({
    eagerRaw: 300_000,
    eagerGz: 100_000,
    chunks: [
      { logical: 'index', kind: 'index', raw: 50_000, gz: 18_000 },
      { logical: 'react-vendor', kind: 'vendor', raw: 150_000, gz: 50_000 },
      { logical: 'chart-vendor', kind: 'vendor', raw: 100_000, gz: 32_000 },
    ],
  })

  it('emits eager total, index, and per-vendor metrics keyed by logical name', () => {
    const items = parseReport('bundle', raw)
    expect(items).toContainEqual({ type: 'metric', name: 'bundle.eager.raw', value: 300_000, unit: 'bytes' })
    expect(items).toContainEqual({ type: 'metric', name: 'bundle.eager.gzip', value: 100_000, unit: 'bytes' })
    expect(items).toContainEqual({ type: 'metric', name: 'bundle.index.raw', value: 50_000, unit: 'bytes' })
    expect(items).toContainEqual({ type: 'metric', name: 'bundle.vendor.react-vendor.gzip', value: 50_000, unit: 'bytes' })
    expect(items).toContainEqual({ type: 'metric', name: 'bundle.vendor.chart-vendor.raw', value: 100_000, unit: 'bytes' })
  })

  it('an unchanged vendor reads as a zero delta in the comparison', () => {
    // Same logical name + same size on both hashes → metric pairs to delta 0.
    const items = parseReport('bundle', raw)
    const m = items.find((i) => i.type === 'metric' && i.name === 'bundle.vendor.react-vendor.raw')
    expect(m).toMatchObject({ value: 150_000 })
  })

  it('survives an empty/missing dist gracefully', () => {
    const items = parseReport('bundle', JSON.stringify({ eagerRaw: 0, eagerGz: 0, chunks: [] }))
    expect(items).toContainEqual({ type: 'metric', name: 'bundle.eager.raw', value: 0, unit: 'bytes' })
    expect(items).toContainEqual({ type: 'summary', kind: 'bundle', summary: { eager: { raw: 0, gz: 0 }, chunks: 0 } })
  })
})
