import { useOverview } from '../hooks/useOverview.ts'
import { paths } from '../lib/paths.ts'
import { relativeTime, absoluteTime } from '../lib/time.ts'
import { StatusPip } from './StatusPip.tsx'
import { Badge } from './Badge.tsx'

export function Overview() {
  const q = useOverview()

  if (q.isPending) return <div class='page-shell'><p class='font-mono text-muted'>Loading…</p></div>
  if (q.isError) return <div class='page-shell'><p class='font-mono text-fail'>Failed to load overview.</p></div>

  const d = q.data
  const stats = [
    { label: 'repos tracked',  value: String(d.repos.length) },
    { label: 'PRs open',       value: String(d.open_prs.length) },
    { label: 'pass rate · 7d', value: d.pass_rate_7d != null ? `${d.pass_rate_7d}%` : '—' },
    { label: 'flaky',          value: String(d.flaky_count), warn: d.flaky_count > 0 },
  ]

  return (
    <div class='page-shell'>
      <h1 class='font-mono text-2xl font-medium tracking-hero text-ink m-0 mb-1'>Overview</h1>
      <p class='font-serif text-lg text-muted mt-0 mb-8'>Your scenes, running in CI — across every app and pull request.</p>

      <div class='grid grid-cols-2 sm:grid-cols-4 gap-4 mb-12'>
        {stats.map((s) => (
          <div key={s.label} class='stat-card'>
            <div class={`stat-value ${s.warn ? 'text-warn' : ''}`}>{s.value}</div>
            <div class='stat-label'>{s.label}</div>
          </div>
        ))}
      </div>

      <h2 class='font-mono text-xl font-medium text-ink mb-5'>Repos</h2>
      {d.repos.length === 0 ? (
        <p class='font-serif text-base text-muted mb-12'>No repos added yet. Go to Projects to add one.</p>
      ) : (
        <div class='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-12'>
          {d.repos.map((repo) => {
            const key = `${repo.owner}/${repo.name}`
            const repoPrs = d.open_prs.filter((pr) => pr.repo === key)
            const hasFailures = repoPrs.some((pr) => pr.latest_status === 'failed')
            const hasRunning  = repoPrs.some((pr) => pr.latest_status === 'running')
            const status = hasFailures ? 'fail' : hasRunning ? 'running' : 'pass'
            return (
              <a key={key} href={paths.repo(repo.owner, repo.name)} class='card-2 card-interactive p-5 block no-underline'>
                <div class='flex items-center justify-between gap-2 mb-3'>
                  <strong class='font-mono text-lg font-medium text-ink truncate min-w-0'>{repo.name}</strong>
                  <StatusPip status={status} className='shrink-0' />
                </div>
                <p class='font-mono text-2xs text-faint m-0'>{repo.owner}</p>
                <div class='flex items-center gap-4 font-mono text-2xs text-faint mt-3'>
                  <span class='ml-auto'>{repoPrs.length} open PR{repoPrs.length !== 1 ? 's' : ''}</span>
                </div>
              </a>
            )
          })}
        </div>
      )}

      <h2 class='font-mono text-xl font-medium text-ink mb-3'>Open pull requests</h2>
      {d.open_prs.length === 0 ? (
        <p class='font-serif text-base text-muted'>No open pull requests.</p>
      ) : (
        <div class='list-panel'>
          {d.open_prs.map((pr) => {
            const slash = pr.repo.indexOf('/')
            const owner = pr.repo.slice(0, slash)
            const name  = pr.repo.slice(slash + 1)
            return (
              <a key={`${pr.repo}#${pr.pr_number}`} href={paths.repo(owner, name)} class='list-row no-underline'>
                <StatusPip status={pr.latest_status ?? 'queued'} />
                <div class='flex-1 min-w-0'>
                  <div class='font-serif text-lg text-ink truncate'>{pr.repo} #{pr.pr_number}</div>
                  <div class='font-mono text-2xs text-faint mt-1' title={absoluteTime(pr.updated_at)}>
                    {pr.base_ref} · {relativeTime(pr.updated_at)}
                  </div>
                </div>
                <Badge tone='pass'>✓ {pr.pass_count ?? 0}</Badge>
                <Badge tone={(pr.fail_count ?? 0) > 0 ? 'fail' : 'neutral'}>✗ {pr.fail_count ?? 0}</Badge>
                <span class='text-faint font-mono'>→</span>
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}
