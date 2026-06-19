import { useLocation } from 'preact-iso'
import { useRepo } from '../hooks/useRepo.ts'
import { useHomeLive, homeTileKey } from '../hooks/useHomeLive.ts'
import { paths } from '../lib/paths.ts'
import { relativeTime, absoluteTime } from '../lib/time.ts'
import { StatusPip } from './StatusPip.tsx'
import { Badge } from './Badge.tsx'
import { Button } from './Button.tsx'
import { ProgressBar } from './ProgressBar.tsx'

interface Props {
  owner: string
  name: string
}

export function RepoDetail({ owner, name }: Props) {
  const { route, query } = useLocation()
  const q = useRepo(owner, name)
  // Live overlay over the D1 snapshot — same home WebSocket as the Overview.
  const live = useHomeLive()
  const back = () => route(paths.overview())

  // The selected PR (from ?pr=N) filters the runs list below. Clicking a PR
  // toggles it; the param keeps the filter deep-linkable and on back/forward.
  const selectedPr = query.pr ? Number(query.pr) : null
  const base = paths.repo(owner, name)
  const togglePr = (n: number) => route(n === selectedPr ? base : `${base}?pr=${n}`)

  if (q.isPending) return <div class='page-shell'><p class='font-mono text-muted'>Loading…</p></div>
  if (q.isError) return (
    <div class='page-shell'>
      <button onClick={back} class='btn-back'>← Overview</button>
      <p class='font-mono text-fail'>Failed to load repo.</p>
    </div>
  )

  const d = q.data
  const runs = selectedPr != null
    ? d.recent_runs.filter((r) => r.pr_number === selectedPr)
    : d.recent_runs

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
          {d.open_prs.map((pr) => {
            const selected = pr.pr_number === selectedPr
            const tile = live.get(homeTileKey(pr.repo, pr.pr_number))
            const status = tile?.status ?? pr.latest_status ?? 'queued'
            return (
              <div
                key={pr.pr_number}
                onClick={() => togglePr(pr.pr_number)}
                aria-pressed={selected}
                title={selected ? 'Showing this PR — click to clear' : 'Filter runs to this PR'}
                class='list-row'
                style={selected ? { boxShadow: 'inset 3px 0 0 var(--color-indigo-500)', background: 'var(--color-card)' } : undefined}
              >
                <StatusPip status={status} />
                <div class='flex-1 min-w-0'>
                  <div class='font-serif text-lg text-ink truncate'>{pr.title ?? `PR #${pr.pr_number}`}</div>
                  <div class='font-mono text-2xs text-faint mt-1' title={absoluteTime(pr.updated_at)}>
                    #{pr.pr_number} · {pr.base_ref} · {pr.run_count} run{pr.run_count !== 1 ? 's' : ''} · updated {relativeTime(pr.updated_at)}
                  </div>
                  {status === 'running' && tile != null && <ProgressBar pct={tile.pct} />}
                </div>
                <Badge tone='pass'>✓ {pr.pass_count ?? 0}</Badge>
                <Badge tone={(pr.fail_count ?? 0) > 0 ? 'fail' : 'neutral'}>✗ {pr.fail_count ?? 0}</Badge>
              </div>
            )
          })}
        </div>
      )}

      <h2 class='font-mono text-xl font-medium text-ink mb-3'>
        Recent runs
        {selectedPr != null && (
          <>
            {' '}<span class='text-faint font-normal'>· PR #{selectedPr}</span>
            <button onClick={() => route(base)} class='ml-3 font-mono text-sm text-accent bg-transparent border-0 cursor-pointer p-0'>clear</button>
          </>
        )}
      </h2>
      {runs.length === 0 ? (
        <p class='font-serif text-base text-muted'>
          {selectedPr != null ? `No runs for PR #${selectedPr} yet.` : 'No runs yet.'}
        </p>
      ) : (
        <div class='list-panel'>
          {runs.map((run) => {
            const when = run.started_at ?? run.ended_at
            const ran = run.started_at != null && run.ended_at != null
            return (
              <div key={run.id} class='list-row'>
                <StatusPip status={run.status} />
                <div class='flex-1 min-w-0'>
                  <div class='font-mono text-sm text-ink'>
                    PR #{run.pr_number} · <span class='text-faint'>{run.head_sha.slice(0, 7)}</span>
                  </div>
                  {when != null && (
                    <div class='font-mono text-2xs text-faint mt-1' title={absoluteTime(when)}>
                      {relativeTime(when)}
                      {ran ? ` · ${Math.round((run.ended_at! - run.started_at!) / 1000)}s` : ''}
                    </div>
                  )}
                </div>
                <Button variant='secondary' size='sm' href={paths.pr(owner, name, run.pr_number, run.id)}>View →</Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
