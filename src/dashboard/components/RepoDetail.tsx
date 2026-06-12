import { useRepo } from '../hooks/useRepo.ts'
import { StatusPip } from './StatusPip.tsx'

interface Props {
  owner: string
  name: string
  onBack: () => void
}

export function RepoDetail({ owner, name, onBack }: Props) {
  const q = useRepo(owner, name)

  if (q.isPending) return <div className='page-shell'><p className='font-mono text-muted'>Loading…</p></div>
  if (q.isError) return (
    <div className='page-shell'>
      <button onClick={onBack} className='btn-back'>← Overview</button>
      <p className='font-mono text-fail'>Failed to load repo.</p>
    </div>
  )

  const d = q.data

  return (
    <div className='page-shell'>
      <button onClick={onBack} className='btn-back'>← Overview</button>
      <h1 className='font-mono text-2xl font-medium tracking-hero text-ink' style={{ margin: '0 0 4px' }}>
        {owner}/{name}
      </h1>
      <p className='font-serif text-lg text-muted' style={{ margin: '0 0 32px' }}>Pull requests and run history.</p>

      <h2 className='font-mono text-xl font-medium text-ink mb-3'>Open pull requests</h2>
      {d.open_prs.length === 0 ? (
        <p className='font-serif text-base text-muted mb-10'>No open pull requests.</p>
      ) : (
        <div className='list-panel mb-10'>
          {d.open_prs.map((pr) => (
            <div key={pr.pr_number} className='list-row' style={{ cursor: 'default' }}>
              <StatusPip status={pr.latest_status ?? 'queued'} />
              <div className='flex-1 min-w-0'>
                <div className='font-serif text-lg text-ink'>PR #{pr.pr_number}</div>
                <div className='font-mono text-2xs text-faint mt-1'>
                  {pr.base_ref} · {pr.run_count} run{pr.run_count !== 1 ? 's' : ''} · updated {new Date(pr.updated_at).toLocaleDateString()}
                </div>
              </div>
              <span className='badge badge-pass'>✓ {pr.pass_count ?? 0}</span>
              <span className={`badge ${(pr.fail_count ?? 0) > 0 ? 'badge-fail' : 'badge-neutral'}`}>
                ✗ {pr.fail_count ?? 0}
              </span>
            </div>
          ))}
        </div>
      )}

      <h2 className='font-mono text-xl font-medium text-ink mb-3'>Recent runs</h2>
      {d.recent_runs.length === 0 ? (
        <p className='font-serif text-base text-muted'>No runs yet.</p>
      ) : (
        <div className='list-panel'>
          {d.recent_runs.map((run) => (
            <div key={run.id} className='list-row'>
              <StatusPip status={run.status} />
              <div className='flex-1 min-w-0'>
                <div className='font-mono text-sm text-ink'>
                  PR #{run.pr_number} · <span className='text-faint'>{run.head_sha.slice(0, 7)}</span>
                </div>
                {run.started_at && (
                  <div className='font-mono text-2xs text-faint mt-1'>
                    {new Date(run.started_at).toLocaleString()}
                    {run.ended_at != null ? ` · ${Math.round((run.ended_at - run.started_at) / 1000)}s` : ''}
                  </div>
                )}
              </div>
              <a
                href={`/r/${run.id}/dashboard`}
                className='btn btn-sm btn-secondary'
                onClick={(e) => e.stopPropagation()}
              >
                View →
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
