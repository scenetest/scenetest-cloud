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
