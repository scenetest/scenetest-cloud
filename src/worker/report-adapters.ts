import type { ReportItem, ReportIssue } from './reports.ts'

// The report adapters (#25): scenetest-cloud owns the parsers for each report
// type, in one place. The box runs the tool (or, for builtin types, does the
// raw IO) and ships machine-readable output up; the worker turns that into the
// normalized metric/summary/issues items the overview_* tables store. Keeping
// the parsing here (not on the box) means a parser fix never re-bakes the image,
// and adding a tool is a new case here, not a schema or agent change.
//
// Every adapter emits at least one `summary` item so the report's presence at a
// hash is recorded even when it found nothing — that summary row is also the
// cache marker ensureBox checks to skip an unchanged report.

export interface AdapterCtx {
  // The box's checkout root, so file paths can be made repo-relative — absolute
  // paths differ between the base and head checkouts and would defeat the
  // cross-hash issue diff.
  root?: string
  // Tool sub-format hint and the command's exit code, for adapters that care.
  tool?: string
  exitCode?: number
}

export function parseReport(type: string, raw: string, ctx: AdapterCtx = {}): ReportItem[] {
  try {
    if (type === 'loc') return locAdapter(raw)
    if (type === 'lint') return lintAdapter(raw, ctx)
    if (type === 'typecheck') return typecheckAdapter(raw, ctx)
    if (type === 'bundle') return bundleAdapter(raw)
  } catch {
    // A tool that emitted unparseable output (crash, wrong format, version skew)
    // records an error summary rather than wrong data — never a bad diff.
    return [{ type: 'summary', kind: type, summary: { error: 'unparseable report output' } }]
  }
  return []
}

// LOC: the box ships { files: [{ path, lines }] } (pure IO it did over the
// checkout); we aggregate to a total and a file count. The per-file detail is
// kept in the summary for a future drill-down.
function locAdapter(raw: string): ReportItem[] {
  const data = JSON.parse(raw) as { files?: Array<{ path?: string; lines?: number }> }
  const files = Array.isArray(data.files) ? data.files : []
  let total = 0
  for (const f of files) if (typeof f.lines === 'number') total += f.lines
  return [
    { type: 'metric', name: 'loc.total', value: total, unit: 'lines' },
    { type: 'metric', name: 'loc.files', value: files.length, unit: 'count' },
    { type: 'summary', kind: 'loc', summary: { total, files: files.length } },
  ]
}

// Lint: the box ships the tool's JSON stdout. Two real shapes are handled,
// auto-detected so `tool` is only a hint:
//   * ESLint `-f json`: an array of file results, each with a messages array.
//   * oxlint `--format=json`: a miette object { diagnostics: [{ message, code,
//     severity, filename, labels: [{ span: { line, column } }] }], … }.
// A flat array of diagnostics is accepted as a fallback. File paths are
// relativized against the checkout root so an issue's fingerprint is stable
// across the base and head builds.
interface EslintMessage {
  ruleId?: string | null
  severity?: number
  line?: number
  column?: number
  message?: string
}
interface EslintFileResult {
  filePath?: string
  messages?: EslintMessage[]
}

interface OxlintDiagnostic {
  message?: string
  code?: string
  severity?: string
  filename?: string
  labels?: Array<{ span?: { line?: number; column?: number } }>
}

function lintAdapter(raw: string, ctx: AdapterCtx): ReportItem[] {
  const trimmed = raw.trim()
  const data: unknown = trimmed === '' ? [] : JSON.parse(trimmed)
  const issues: ReportIssue[] = []
  let errors = 0
  let warnings = 0

  const rel = (p: string | undefined): string | undefined => {
    if (!p) return p
    if (ctx.root && p.startsWith(ctx.root)) return p.slice(ctx.root.length).replace(/^\/+/, '')
    return p
  }
  const push = (file: string | undefined, m: EslintMessage) => {
    const severity = m.severity === 2 ? 'error' : 'warning'
    if (severity === 'error') errors++
    else warnings++
    issues.push({
      ...(rel(file) ? { file: rel(file) } : {}),
      ...(typeof m.line === 'number' ? { line: m.line } : {}),
      ...(typeof m.column === 'number' ? { col: m.column } : {}),
      severity,
      ...(m.message ? { message: m.message } : {}),
      ...(m.ruleId ? { raw: m.ruleId } : {}),
    })
  }

  if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray((data as { diagnostics?: unknown }).diagnostics)) {
    // oxlint (miette) shape: line/column live in the first label's span; the
    // rule rides in `code` (e.g. "eslint(no-debugger)").
    for (const d of (data as { diagnostics: OxlintDiagnostic[] }).diagnostics) {
      const span = Array.isArray(d.labels) && d.labels[0]?.span ? d.labels[0]!.span! : undefined
      push(d.filename, {
        ruleId: d.code ?? null,
        severity: d.severity === 'error' ? 2 : 1,
        line: span?.line,
        column: span?.column,
        message: d.message,
      })
    }
  } else if (Array.isArray(data) && data.every((d) => d && typeof d === 'object' && 'messages' in (d as object))) {
    // ESLint shape: [{ filePath, messages: [...] }]
    for (const f of data as EslintFileResult[]) {
      for (const m of f.messages ?? []) push(f.filePath, m)
    }
  } else if (Array.isArray(data)) {
    // Flat diagnostics: [{ filename|file, line, column, severity, message, ruleId }]
    for (const d of data as Array<Record<string, unknown>>) {
      const sev = typeof d.severity === 'number' ? d.severity : d.severity === 'error' ? 2 : 1
      push((d.filename as string) ?? (d.file as string), {
        ruleId: (d.ruleId as string) ?? (d.rule as string) ?? null,
        severity: sev,
        line: d.line as number,
        column: (d.column as number) ?? (d.col as number),
        message: d.message as string,
      })
    }
  }

  return [
    { type: 'issues', kind: 'lint', issues },
    { type: 'summary', kind: 'lint', summary: { errors, warnings } },
    { type: 'metric', name: 'lint.errors', value: errors, unit: 'count' },
    { type: 'metric', name: 'lint.warnings', value: warnings, unit: 'count' },
  ]
}

// Typecheck: the box ships `tsc`'s default (non-pretty) stdout. Each diagnostic
// is one line, `file(line,col): error TS####: message` (tsc can also emit
// `warning`). We parse those lines and ignore the rest (summaries, blank
// lines). The TS code rides in `raw`; `message` keeps the `TS####: …` text so
// the cross-hash diff distinguishes two different errors at the same position.
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$/

function typecheckAdapter(raw: string, ctx: AdapterCtx): ReportItem[] {
  const issues: ReportIssue[] = []
  let errors = 0
  let warnings = 0
  const rel = (p: string) => (ctx.root && p.startsWith(ctx.root) ? p.slice(ctx.root.length).replace(/^\/+/, '') : p)

  for (const line of raw.split('\n')) {
    const m = TSC_LINE.exec(line.trim())
    if (!m) continue
    const [, file, ln, col, sev, code, text] = m as unknown as [string, string, string, string, string, string, string]
    if (sev === 'error') errors++
    else warnings++
    issues.push({
      file: rel(file),
      line: parseInt(ln, 10),
      col: parseInt(col, 10),
      severity: sev,
      message: `${code}: ${text}`,
      raw: code,
    })
  }

  return [
    { type: 'issues', kind: 'typecheck', issues },
    { type: 'summary', kind: 'typecheck', summary: { errors, warnings } },
    { type: 'metric', name: 'typecheck.errors', value: errors, unit: 'count' },
    { type: 'metric', name: 'typecheck.warnings', value: warnings, unit: 'count' },
  ]
}

// Bundle: the box measures the built output dir (the eager-load JS — the entry
// chunk plus every modulepreload chunk in index.html — with raw and gzipped
// sizes) and ships this structured shape. The adapter turns it into metrics so
// the comparison shows the deltas a first paint actually downloads. Vendor
// chunks become per-chunk metrics keyed by their logical name (the content hash
// stripped), so an unchanged vendor reads as a zero delta and a grown one
// stands out. Built on the reference CI's measure(): see the original-motivation
// workflow.
interface BundleChunk {
  logical?: string // hash-stripped name, e.g. 'react-vendor'
  kind?: 'index' | 'vendor' | 'other'
  raw?: number
  gz?: number
}
interface BundleData {
  eagerRaw?: number
  eagerGz?: number
  chunks?: BundleChunk[]
}

function bundleAdapter(raw: string): ReportItem[] {
  const data = JSON.parse(raw) as BundleData
  const chunks = Array.isArray(data.chunks) ? data.chunks : []
  const metrics: ReportItem[] = [
    { type: 'metric', name: 'bundle.eager.raw', value: data.eagerRaw ?? 0, unit: 'bytes' },
    { type: 'metric', name: 'bundle.eager.gzip', value: data.eagerGz ?? 0, unit: 'bytes' },
  ]
  const index = chunks.find((c) => c.kind === 'index')
  if (index) {
    metrics.push({ type: 'metric', name: 'bundle.index.raw', value: index.raw ?? 0, unit: 'bytes' })
    metrics.push({ type: 'metric', name: 'bundle.index.gzip', value: index.gz ?? 0, unit: 'bytes' })
  }
  for (const c of chunks) {
    if (c.kind !== 'vendor' || !c.logical) continue
    metrics.push({ type: 'metric', name: `bundle.vendor.${c.logical}.raw`, value: c.raw ?? 0, unit: 'bytes' })
    metrics.push({ type: 'metric', name: `bundle.vendor.${c.logical}.gzip`, value: c.gz ?? 0, unit: 'bytes' })
  }
  return [
    ...metrics,
    {
      type: 'summary',
      kind: 'bundle',
      summary: {
        eager: { raw: data.eagerRaw ?? 0, gz: data.eagerGz ?? 0 },
        chunks: chunks.length,
      },
    },
  ]
}
