import { useLocation } from 'preact-iso'
import { useRepo } from '../hooks/useRepo.ts'
import { paths } from '../lib/paths.ts'
import { StatusPip } from './StatusPip.tsx'
import { Badge } from './Badge.tsx'
import { Button } from './Button.tsx'

interface Props {
  owner: string
  name: string
}

export function RepoDetail({ owner, name }: Props) {
  const { route } = useLocation()
  const q = useRepo(owner, name)
  const back = () => route(paths.overview())

  if (q.isPending) return <div class='page-shell'><p class='font-mono text-muted'>Loading…</p></div>
  if (q.isError) return (
    <div class='page-shell'>
      <button onClick={back} class='btn-back'>← Overview</button>
      <p class='font-mono text-fail'>Failed to load repo.</p>
    </div>
  )

  const d = q.data

  return (
    <div class='page-shell'>
      <button onClick={back} class='btn-back'>← Overview</button>
      <h1 class='font-mono text-2xl font-medium tracking-hero text-ink m-0 mb-1'>{owner}/{name}</h1>
      <p class='font-serif text-lg text-muted mt-0 mb-8'>Pull requests and run history.</p>

      <h2 class='font-mono text-xl font-medium text-ink mb-3'>Open pull requests</h2>
      {d.open_prs.length === 0 ? (
        <p class='font-serif text-base text-muted mb-12'>No open pull requests.</p>
      ) : (
        <div class='list-panel mb-12'>
          {d.open_prs.map((pr) => (
            <div key={pr.pr_number} class='list-row cursor-default'>
              <StatusPip status={pr.latest_status ?? 'queued'} />
              <div class='flex-1 min-w-0'>
                <div class='font-serif text-lg text-ink'>PR #{pr.pr_number}</div>
                <div class='font-mono text-2xs text-faint mt-1'>
                  {pr.base_ref} · {pr.run_count} run{pr.run_count !== 1 ? 's' : ''} · updated {new Date(pr.updated_at).toLocaleDateString()}
                </div>
              </div>
              <Badge tone='pass'>✓ {pr.pass_count ?? 0}</Badge>
              <Badge tone={(pr.fail_count ?? 0) > 0 ? 'fail' : 'neutral'}>✗ {pr.fail_count ?? 0}</Badge>
            </div>
          ))}
        </div>
      )}

      <h2 class='font-mono text-xl font-medium text-ink mb-3'>Recent runs</h2>
      {d.recent_runs.length === 0 ? (
        <p class='font-serif text-base text-muted'>No runs yet.</p>
      ) : (
        <div class='list-panel'>
          {d.recent_runs.map((run) => (
            <div key={run.id} class='list-row'>
              <StatusPip status={run.status} />
              <div class='flex-1 min-w-0'>
                <div class='font-mono text-sm text-ink'>
                  PR #{run.pr_number} · <span class='text-faint'>{run.head_sha.slice(0, 7)}</span>
                </div>
                {run.started_at && (
                  <div class='font-mono text-2xs text-faint mt-1'>
                    {new Date(run.started_at).toLocaleString()}
                    {run.ended_at != null ? ` · ${Math.round((run.ended_at - run.started_at) / 1000)}s` : ''}
                  </div>
                )}
              </div>
              <Button variant='secondary' size='sm' href={`/r/${run.id}/dashboard`}>View →</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
