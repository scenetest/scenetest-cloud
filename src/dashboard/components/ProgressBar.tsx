interface Props {
  pct: number
}

// A running PR's live progress, painted in the home-view's document aesthetic
// (cloud chrome, not the run widget). Shown only while a run is in flight.
export function ProgressBar({ pct }: Props) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div
      role='progressbar'
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{ height: '3px', marginTop: '8px', background: 'var(--color-card)', borderRadius: '2px', overflow: 'hidden' }}
    >
      <div style={{ height: '100%', width: `${clamped}%`, background: 'var(--color-indigo-500)', transition: 'width .3s ease' }} />
    </div>
  )
}
