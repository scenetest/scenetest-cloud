import { describe, expect, it } from 'vitest'
import {
  computeReportPlan,
  computeVector,
  defaultPipeline,
  firstDivergentStage,
  globToRegExp,
  matchesAny,
  parsePipeline,
  parseReports,
  type StagePlan,
  type TreeEntry,
} from './pipeline.ts'

describe('parsePipeline', () => {
  it('accepts a minimal valid file and defaults watch to **', () => {
    const cfg = parsePipeline('{"version":1,"stages":[{"name":"deps","run":"pnpm i"}]}')
    expect(cfg).toEqual({
      version: 1,
      stages: [{ name: 'deps', watch: ['**'], run: 'pnpm i' }],
      reports: [],
      scenes: 'bash scenetest/box-run.sh',
    })
  })

  it('carries the scenes command, defaulting to the legacy hook', () => {
    expect(parsePipeline('{"version":1,"stages":[{"name":"a"}],"scenes":"pnpm scenes run"}')?.scenes)
      .toBe('pnpm scenes run')
    expect(parsePipeline('{"version":1,"stages":[{"name":"a"}]}')?.scenes)
      .toBe('bash scenetest/box-run.sh')
    expect(parsePipeline('{"version":1,"stages":[{"name":"a"}],"scenes":3}')).toBeNull()
  })

  it('tolerates reserved fields (save/restore/toolchain) silently', () => {
    const cfg = parsePipeline(
      '{"version":1,"stages":[{"name":"db","watch":["supabase/**"],"run":"x","save":"s","restore":"r"}]}',
    )
    expect(cfg?.stages[0]).toEqual({ name: 'db', watch: ['supabase/**'], run: 'x' })
  })

  it.each([
    ['not json', 'nope{'],
    ['wrong version', '{"version":2,"stages":[{"name":"a"}]}'],
    ['empty stages', '{"version":1,"stages":[]}'],
    ['bad name', '{"version":1,"stages":[{"name":"Has Spaces"}]}'],
    ['duplicate names', '{"version":1,"stages":[{"name":"a"},{"name":"a"}]}'],
    ['non-string glob', '{"version":1,"stages":[{"name":"a","watch":[3]}]}'],
  ])('rejects %s (falls back to default)', (_label, raw) => {
    expect(parsePipeline(raw)).toBeNull()
  })
})

describe('glob matching', () => {
  it.each([
    ['**', 'anything/at/all.ts', true],
    ['supabase/**', 'supabase/migrations/0001.sql', true],
    ['supabase/**', 'supabase', false], // blobs only; the dir itself never appears
    ['supabase/**', 'src/supabase.ts', false],
    ['*.lock', 'pnpm-lock.yaml', false],
    ['pnpm-lock.yaml', 'pnpm-lock.yaml', true],
    ['src/**', 'src/a/b/c.tsx', true],
    ['*.md', 'README.md', true],
    ['*.md', 'docs/notes.md', false], // single * does not cross '/'
    ['docs/*.md', 'docs/notes.md', true],
  ])('%s vs %s → %s', (glob, path, want) => {
    expect(globToRegExp(glob).test(path)).toBe(want)
  })

  it('matchesAny over several globs', () => {
    expect(matchesAny('vite.config.ts', ['src/**', '*.config.ts'])).toBe(true)
    expect(matchesAny('LICENSE', ['src/**', '*.config.ts'])).toBe(false)
  })
})

const TREE: TreeEntry[] = [
  { path: 'pnpm-lock.yaml', sha: 'lock1' },
  { path: 'supabase/migrations/0001.sql', sha: 'mig1' },
  { path: 'src/app.tsx', sha: 'app1' },
  { path: 'docs/readme.md', sha: 'doc1' },
]

const CONFIG = parsePipeline(JSON.stringify({
  version: 1,
  stages: [
    { name: 'deps', watch: ['pnpm-lock.yaml'], run: 'pnpm i' },
    { name: 'db', watch: ['supabase/**'], run: 'supabase db reset' },
    { name: 'build', watch: ['src/**'], run: 'pnpm build' },
  ],
}))!

describe('computeVector', () => {
  it('is deterministic and cascades parent hashes', async () => {
    const a = await computeVector(CONFIG, TREE, 'root', 'pf1')
    const b = await computeVector(CONFIG, TREE, 'root', 'pf1')
    expect(a.vector).toEqual(b.vector)
    expect(Object.keys(a.vector)).toEqual(['deps', 'db', 'build'])
  })

  it('an unwatched change (docs) changes nothing', async () => {
    const docsChanged = TREE.map((e) => (e.path === 'docs/readme.md' ? { ...e, sha: 'doc2' } : e))
    const a = await computeVector(CONFIG, TREE, 'root', 'pf1')
    const b = await computeVector(CONFIG, docsChanged, 'root', 'pf1')
    expect(b.vector).toEqual(a.vector)
  })

  it('a db change invalidates db and build but not deps', async () => {
    const dbChanged = TREE.map((e) => (e.path.startsWith('supabase/') ? { ...e, sha: 'mig2' } : e))
    const a = await computeVector(CONFIG, TREE, 'root', 'pf1')
    const b = await computeVector(CONFIG, dbChanged, 'root', 'pf1')
    expect(b.vector.deps).toBe(a.vector.deps)
    expect(b.vector.db).not.toBe(a.vector.db)
    expect(b.vector.build).not.toBe(a.vector.build) // cascade via parent hash
  })

  it('editing the pipeline file itself invalidates every stage', async () => {
    const a = await computeVector(CONFIG, TREE, 'root', 'pf1')
    const b = await computeVector(CONFIG, TREE, 'root', 'pf2')
    for (const name of Object.keys(a.vector)) expect(b.vector[name]).not.toBe(a.vector[name])
  })

  it('a new image (root hash) invalidates every stage', async () => {
    const a = await computeVector(CONFIG, TREE, 'root', 'pf1')
    const b = await computeVector(CONFIG, TREE, 'root2', 'pf1')
    for (const name of Object.keys(a.vector)) expect(b.vector[name]).not.toBe(a.vector[name])
  })
})

describe('parseReports', () => {
  it('keeps valid entries and drops malformed ones (additive, never fatal)', () => {
    const reports = parseReports([
      { name: 'loc', type: 'loc', watch: ['src/**'], exclude: ['**/*.test.ts'] },
      { name: 'lint', type: 'lint', watch: ['src/**'], run: 'eslint -f json src', after: 'build' },
      { name: 'bad-no-watch', type: 'loc' },
      { name: 'bad-type', type: 'nope', watch: ['x'] },
      { name: 'lint-no-run', type: 'lint', watch: ['x'] },
      { name: 'loc', type: 'loc', watch: ['dup'] }, // duplicate name
    ])
    expect(reports.map((r) => r.name)).toEqual(['loc', 'lint'])
    expect(reports[1]).toEqual({ name: 'lint', type: 'lint', watch: ['src/**'], run: 'eslint -f json src', after: 'build' })
  })

  it('is empty for a non-array or absent reports field', () => {
    expect(parseReports(undefined)).toEqual([])
    expect(parseReports('nope')).toEqual([])
  })
})

describe('computeReportPlan', () => {
  const reports = parseReports([
    { name: 'loc', type: 'loc', watch: ['src/**'] },
    { name: 'lint', type: 'lint', watch: ['src/**'], run: 'eslint -f json', after: 'build' },
  ])

  it('keys each report by its watched content and is deterministic', async () => {
    const vector = (await computeVector(CONFIG, TREE, 'root', 'pf1')).vector
    const a = await computeReportPlan(reports, TREE, vector, 'root', 'pf1')
    const b = await computeReportPlan(reports, TREE, vector, 'root', 'pf1')
    expect(a.reports).toEqual(b.reports)
    expect(Object.keys(a.reports)).toEqual(['loc', 'lint'])
    expect(a.items.map((i) => i.name)).toEqual(['loc', 'lint'])
  })

  it('a source change moves both reports (they watch src/**)', async () => {
    const vector = (await computeVector(CONFIG, TREE, 'root', 'pf1')).vector
    const srcChanged = TREE.map((e) => (e.path === 'src/app.tsx' ? { ...e, sha: 'app2' } : e))
    const vector2 = (await computeVector(CONFIG, srcChanged, 'root', 'pf1')).vector
    const a = await computeReportPlan(reports, TREE, vector, 'root', 'pf1')
    const b = await computeReportPlan(reports, srcChanged, vector2, 'root', 'pf1')
    expect(b.reports.loc).not.toBe(a.reports.loc)
    expect(b.reports.lint).not.toBe(a.reports.lint)
  })

  it("a toolchain change (parent stage hash) moves the report that declares `after`", async () => {
    // 'lint' is after 'build'; a deps change cascades into build's hash, so
    // lint's hash moves while loc (no `after`, source unchanged) stays put.
    const vector = (await computeVector(CONFIG, TREE, 'root', 'pf1')).vector
    const depsChanged = TREE.map((e) => (e.path === 'pnpm-lock.yaml' ? { ...e, sha: 'lock2' } : e))
    const vector2 = (await computeVector(CONFIG, depsChanged, 'root', 'pf1')).vector
    const a = await computeReportPlan(reports, TREE, vector, 'root', 'pf1')
    const b = await computeReportPlan(reports, depsChanged, vector2, 'root', 'pf1')
    expect(b.reports.loc).toBe(a.reports.loc)
    expect(b.reports.lint).not.toBe(a.reports.lint)
  })
})

describe('firstDivergentStage', () => {
  const plan = (vector: Record<string, string>): StagePlan => ({
    vector,
    stages: Object.keys(vector).map((name) => ({ name })),
    reports: {},
    reportItems: [],
    scenes: 'bash scenetest/box-run.sh',
    coarse: false,
  })

  it('null when realized matches exactly (full reuse)', () => {
    expect(firstDivergentStage(plan({ a: '1', b: '2' }), { a: '1', b: '2' })).toBeNull()
  })

  it('0 when nothing is realized yet', () => {
    expect(firstDivergentStage(plan({ a: '1' }), null)).toBe(0)
  })

  it('picks the first mismatch, not the last', () => {
    expect(firstDivergentStage(plan({ a: '1', b: '2', c: '3' }), { a: '1', b: 'X', c: 'X' })).toBe(1)
  })

  it('a stage rename or coarse↔fine transition diverges at 0', () => {
    expect(firstDivergentStage(plan({ renamed: '1' }), { '*coarse*': 'sha1' })).toBe(0)
  })

  it('default pipeline keeps the legacy setup hook', () => {
    expect(defaultPipeline().stages[0]!.run).toContain('box-setup.sh')
  })
})
