import { useOverview } from '../hooks/useOverview.ts'
import { StatusPip } from './StatusPip.tsx'

interface Props {
  onOpenRepo: (owner: string, name: string) => void
}

export function Overview({ onOpenRepo }: Props) {
  const q = useOverview()

  if (q.isPending) return <div className='page-shell'><p className='font-mono text-muted'>Loading…</p></div>
  if (q.isError) return <div className='page-shell'><p className='font-mono text-fail'>Failed to load overview.</p></div>

  const d = q.data
  const stats = [
    { label: 'repos tracked', value: String(d.repos.length) },
    { label: 'PRs open', value: String(d.open_prs.length) },
    { label: 'pass rate · 7d', value: d.pass_rate_7d != null ? `${d.pass_rate_7d}%` : '—' },
    { label: 'flaky', value: String(d.flaky_count), tone: d.flaky_count > 0 ? 'warn' : undefined },
  ]

  return (
    <div className='page-shell'>
      <h1 className='font-mono text-2xl font-medium tracking-hero text-ink' style={{ margin: '0 0 4px' }}>Overview</h1>
      <p className='font-serif text-lg text-muted' style={{ margin: '0 0 32px' }}>Your scenes, running in CI — across every app and pull request.</p>

      <div className='grid grid-4 mb-10'>
        {stats.map((s) => (
          <div key={s.label} className='stat-card'>
            <div className='stat-value' style={s.tone === 'warn' ? { color: 'var(--warn-solid)' } : {}}>
              {s.value}
            </div>
            <div className='stat-label'>{s.label}</div>
          </div>
        ))}
      </div>

      <h2 className='font-mono text-xl font-medium text-ink mb-5'>Repos</h2>
      {d.repos.length === 0 ? (
        <p className='font-serif text-base text-muted mb-10'>No repos added yet. Go to Projects to add one.</p>
      ) : (
        <div className='grid grid-3 mb-10'>
          {d.repos.map((repo) => {
            const key = `${repo.owner}/${repo.name}`
            const repoPrs = d.open_prs.filter((pr) => pr.repo === key)
            const hasFailures = repoPrs.some((pr) => pr.latest_status === 'failed')
            const hasRunning = repoPrs.some((pr) => pr.latest_status === 'running')
            const status = hasFailures ? 'fail' : hasRunning ? 'running' : 'pass'
            return (
              <div
                key={key}
                onClick={() => onOpenRepo(repo.owner, repo.name)}
                className='card-2 card-interactive'
                style={{ padding: '20px 22px' }}
              >
                <div className='flex items-center justify-between mb-3'>
                  <strong className='font-mono text-lg font-medium text-ink'>{repo.name}</strong>
                  <StatusPip status={status} />
                </div>
                <p className='font-mono text-2xs text-faint' style={{ margin: 0 }}>{repo.owner}</p>
                <div className='flex items-center gap-4 font-mono text-2xs text-faint' style={{ marginTop: 12 }}>
                  <span className='ml-auto'>{repoPrs.length} open PR{repoPrs.length !== 1 ? 's' : ''}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <h2 className='font-mono text-xl font-medium text-ink mb-3'>Open pull requests</h2>
      {d.open_prs.length === 0 ? (
        <p className='font-serif text-base text-muted'>No open pull requests.</p>
      ) : (
        <div className='list-panel'>
          {d.open_prs.map((pr) => {
            const slash = pr.repo.indexOf('/')
            const owner = pr.repo.slice(0, slash)
            const name = pr.repo.slice(slash + 1)
            return (
              <div
                key={`${pr.repo}#${pr.pr_number}`}
                onClick={() => onOpenRepo(owner, name)}
                className='list-row'
              >
                <StatusPip status={pr.latest_status ?? 'queued'} />
                <div className='flex-1 min-w-0'>
                  <div className='font-serif text-lg text-ink'>{pr.repo} #{pr.pr_number}</div>
                  <div className='font-mono text-2xs text-faint mt-1'>
                    {pr.base_ref} · {new Date(pr.updated_at).toLocaleDateString()}
                  </div>
                </div>
                <span className='badge badge-pass'>✓ {pr.pass_count ?? 0}</span>
                <span className={`badge ${(pr.fail_count ?? 0) > 0 ? 'badge-fail' : 'badge-neutral'}`}>
                  ✗ {pr.fail_count ?? 0}
                </span>
                <span className='text-faint font-mono'>→</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
