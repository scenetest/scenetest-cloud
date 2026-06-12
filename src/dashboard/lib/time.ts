// Compact, human relative time — "just now", "2m", "3h", "5d", "2w" — then an
// absolute date once it's old enough that "Nw" stops being useful. Used for
// run and PR timestamps in the dashboard lists.
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts
  if (diff < 45_000) return 'just now'
  const m = Math.floor(diff / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  const w = Math.floor(d / 7)
  if (w < 5) return `${w}w`
  return new Date(ts).toLocaleDateString()
}

// The full timestamp, for a title tooltip behind the relative one.
export function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString()
}
