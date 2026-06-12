import { useRepoMetrics } from '../hooks/useRepoMetrics.ts'
import type { MetricSeries } from '../types.ts'

interface Props {
  owner: string
  name: string
}

// The main-branch metric timeline: one sparkline per tracked metric, charted
// over merges. Cloud-painted, so it uses the docs aesthetic (not the terminal
// widget style). Quiet until merges with reported metrics exist.
export function MetricTimeline({ owner, name }: Props) {
  const q = useRepoMetrics(owner, name)
  if (q.isPending || q.isError) return null

  const series = q.data.metrics
  if (series.length === 0) return null

  return (
    <>
      <h2 class='font-mono text-xl font-medium text-ink mb-1'>Metrics over time</h2>
      <p class='font-serif text-base text-muted mt-0 mb-5'>
        Sampled at each merge to <code class='font-mono text-sm'>{q.data.base_ref}</code>.
      </p>
      <div class='grid grid-cols-2 gap-4 mb-12'>
        {series.map((s) => <MetricCard key={s.name} series={s} />)}
      </div>
    </>
  )
}

// ---- formatting ------------------------------------------------------------

function isBundle(name: string): boolean {
  return name.startsWith('bundle') || name.endsWith('.bytes') || name.endsWith('.size')
}

function formatValue(name: string, value: number): string {
  if (!isBundle(name)) return value.toLocaleString()
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(2)} MB`
}

function formatDelta(name: string, delta: number): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±'
  return `${sign}${formatValue(name, Math.abs(delta))}`
}

// Lower is better for bundle sizes, so a drop is the good direction.
function deltaTone(name: string, delta: number): string {
  if (delta === 0) return 'text-faint'
  if (!isBundle(name)) return 'text-muted'
  return delta < 0 ? 'text-pass' : 'text-warn'
}

// ---- chart -----------------------------------------------------------------

const W = 600
const H = 130
const PAD_X = 10
const PAD_TOP = 12
const PAD_BOTTOM = 12

function MetricCard({ series }: { series: MetricSeries }) {
  const pts = series.points
  const first = pts[0]!
  const last = pts[pts.length - 1]!
  const delta = last.value - first.value

  const values = pts.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const innerW = W - PAD_X * 2
  const innerH = H - PAD_TOP - PAD_BOTTOM

  const x = (i: number) => (pts.length === 1 ? W / 2 : PAD_X + (i / (pts.length - 1)) * innerW)
  const y = (v: number) => PAD_TOP + (1 - (v - min) / span) * innerH

  const linePts = pts.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')
  const areaPts = `${PAD_X},${H - PAD_BOTTOM} ${linePts} ${W - PAD_X},${H - PAD_BOTTOM}`

  return (
    <div class='card-2 p-5'>
      <div class='flex items-baseline justify-between mb-1'>
        <strong class='font-mono text-sm text-ink'>{series.name}</strong>
        <span class='font-mono text-2xs text-faint'>{pts.length} merge{pts.length !== 1 ? 's' : ''}</span>
      </div>
      <div class='flex items-baseline gap-2 mb-3'>
        <span class='font-mono text-2xl font-medium text-ink leading-none'>{formatValue(series.name, last.value)}</span>
        {pts.length > 1 && (
          <span class={`font-mono text-xs ${deltaTone(series.name, delta)}`}>{formatDelta(series.name, delta)}</span>
        )}
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} class='w-full h-auto block' preserveAspectRatio='xMidYMid meet'>
        {pts.length > 1 && (
          <polygon points={areaPts} fill='var(--color-accent)' opacity='0.08' />
        )}
        {pts.length > 1 && (
          <polyline
            points={linePts}
            fill='none'
            stroke='var(--color-accent)'
            stroke-width='2'
            stroke-linejoin='round'
            stroke-linecap='round'
          />
        )}
        {pts.map((p, i) => (
          <circle key={p.commit_sha} cx={x(i)} cy={y(p.value)} r={pts.length > 40 ? 1.5 : 3} fill='var(--color-accent)'>
            <title>
              {p.commit_sha.slice(0, 7)}
              {p.pr_number != null ? ` · #${p.pr_number}` : ''} · {formatValue(series.name, p.value)} · {new Date(p.recorded_at).toLocaleDateString()}
            </title>
          </circle>
        ))}
      </svg>

      <div class='flex justify-between font-mono text-2xs text-faint mt-2'>
        <span>{new Date(first.recorded_at).toLocaleDateString()}</span>
        <span>{last.commit_sha.slice(0, 7)} · {new Date(last.recorded_at).toLocaleDateString()}</span>
      </div>
    </div>
  )
}
