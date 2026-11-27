import { usePrReports } from '../hooks/usePrReports.ts'
import type { MetricComparison, IssuesComparison, ReportIssue } from '../types.ts'

interface Props {
  owner: string
  name: string
  prNumber: number
}

// The PR's static-analysis comparison (#25): lint/typecheck deltas and bundle
// sizes, "report at base hash vs report at head hash", per stage. Painted by
// cloud code in the docs aesthetic (not the terminal widget — that is the run
// pane below). Renders nothing until at least one report exists, so a PR whose
// stages emit no reports shows no empty chrome.
export function PrReports({ owner, name, prNumber }: Props) {
  const q = usePrReports(owner, name, prNumber)
  const c = q.data?.comparison
  if (!c) return null
  const hasIssues = c.issues.some((i) => i.added.length + i.resolved.length + i.unchanged + i.moved > 0)
  if (c.metrics.length === 0 && c.summaries.length === 0 && !hasIssues) return null

  return (
    <section class='mb-8'>
      <h2 class='font-mono text-sm font-medium text-ink m-0 mb-3'>
        Static analysis
        {c.baseMissing && (
          <span class='font-mono text-2xs text-faint ml-2'>· no base to compare against</span>
        )}
      </h2>

      {c.metrics.length > 0 && (
        <div class='card p-4 mb-3'>
          <table class='w-full border-collapse'>
            <thead>
              <tr class='text-left font-mono text-2xs text-faint'>
                <th class='font-normal pb-2'>metric</th>
                <th class='font-normal pb-2 text-right'>base</th>
                <th class='font-normal pb-2 text-right'>head</th>
                <th class='font-normal pb-2 text-right'>Δ</th>
              </tr>
            </thead>
            <tbody>
              {c.metrics.map((m) => (
                <MetricRow key={`${m.stage}:${m.name}`} m={m} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasIssues &&
        c.issues
          .filter((i) => i.added.length + i.resolved.length + i.unchanged + i.moved > 0)
          .map((i) => <IssuesBlock key={`${i.stage}:${i.kind}`} i={i} />)}
    </section>
  )
}

function MetricRow({ m }: { m: MetricComparison }) {
  const fmt = (v: number | null) => (v == null ? '—' : formatValue(v, m.unit))
  // Default polarity for these metrics (bundle bytes, error/warning counts):
  // larger is worse. A null delta (one side missing) gets no colour.
  const deltaClass = m.delta == null ? 'text-faint' : m.delta > 0 ? 'text-fail' : m.delta < 0 ? 'text-pass' : 'text-faint'
  return (
    <tr class='font-mono text-xs text-ink border-t border-border'>
      <td class='py-1.5'>
        <span class='text-faint'>{m.stage}·</span>
        {m.name}
      </td>
      <td class='py-1.5 text-right text-muted'>{fmt(m.base)}</td>
      <td class='py-1.5 text-right'>{fmt(m.head)}</td>
      <td class={`py-1.5 text-right ${deltaClass}`}>
        {m.delta == null ? '—' : `${m.delta > 0 ? '+' : ''}${formatValue(m.delta, m.unit)}`}
      </td>
    </tr>
  )
}

function IssuesBlock({ i }: { i: IssuesComparison }) {
  return (
    <div class='card p-4 mb-3'>
      <div class='font-mono text-xs text-ink mb-2'>
        <span class='text-faint'>{i.stage}·</span>
        {i.kind}
        <span class='text-faint ml-2'>
          {i.added.length > 0 && <span class='text-fail'>+{i.added.length} new</span>}
          {i.added.length > 0 && i.resolved.length > 0 && ' · '}
          {i.resolved.length > 0 && <span class='text-pass'>−{i.resolved.length} resolved</span>}
          {(i.added.length > 0 || i.resolved.length > 0) && (i.unchanged > 0 || i.moved > 0) && ' · '}
          {i.unchanged > 0 && `${i.unchanged} unchanged`}
          {i.unchanged > 0 && i.moved > 0 && ' · '}
          {i.moved > 0 && `${i.moved} shifted`}
        </span>
      </div>
      {i.added.map((issue, n) => (
        <IssueLine key={`a${n}`} issue={issue} tone='fail' mark='+' />
      ))}
      {i.resolved.map((issue, n) => (
        <IssueLine key={`r${n}`} issue={issue} tone='pass' mark='−' />
      ))}
    </div>
  )
}

function IssueLine({ issue, tone, mark }: { issue: ReportIssue; tone: 'fail' | 'pass'; mark: string }) {
  const loc = issue.file ? `${issue.file}${issue.line != null ? `:${issue.line}` : ''}` : ''
  return (
    <div class='font-mono text-2xs text-muted leading-relaxed'>
      <span class={tone === 'fail' ? 'text-fail' : 'text-pass'}>{mark}</span> {loc && <span class='text-ink'>{loc}</span>}{' '}
      {issue.message}
    </div>
  )
}

function formatValue(v: number, unit: string | null): string {
  if (unit === 'bytes') return formatBytes(v)
  // Integer counts render bare; fractional values keep two places.
  return Number.isInteger(v) ? String(v) : v.toFixed(2)
}

function formatBytes(v: number): string {
  const sign = v < 0 ? '-' : ''
  let n = Math.abs(v)
  const units = ['B', 'KB', 'MB']
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  return `${sign}${u === 0 ? n : n.toFixed(1)} ${units[u]}`
}
