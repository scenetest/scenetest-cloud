import { useState } from 'preact/hooks'
import { useOverview } from '../hooks/useOverview.ts'

interface Props {
  onOpenRepo: (owner: string, name: string) => void
}

export function ProjectsView({ onOpenRepo }: Props) {
  const q = useOverview()
  const [showAdd, setShowAdd] = useState(false)

  if (q.isPending) return <div className='page-shell'><p className='font-mono text-muted'>Loading…</p></div>
  if (q.isError) return <div className='page-shell'><p className='font-mono text-fail'>Failed to load repos.</p></div>

  const d = q.data

  return (
    <div className='page-shell'>
      <div className='flex items-baseline justify-between mb-2'>
        <h1 className='font-mono text-2xl font-medium tracking-hero text-ink' style={{ margin: 0 }}>Projects</h1>
        <button onClick={() => setShowAdd(true)} className='btn btn-primary btn-lg shrink-0'>
          + Add project
        </button>
      </div>
      <p className='font-serif text-lg text-muted' style={{ margin: '0 0 32px' }}>
        Every GitHub repository Scenetest is watching. Scan the left column for PRs that need attention.
      </p>

      <div className='list-panel bg-paper'>
        <div className='table-head'>
          <span style={{ width: 130 }}>Open PRs</span>
          <span className='flex-1'>Repository</span>
          <span style={{ width: 72, textAlign: 'right' }}>Pass · 7d</span>
          <span style={{ width: 20 }}></span>
        </div>
        {d.repos.length === 0 && (
          <div className='list-row' style={{ cursor: 'default' }}>
            <span className='font-serif text-base text-muted'>No repos yet. Click "Add project" to get started.</span>
          </div>
        )}
        {d.repos.map((repo) => {
          const key = `${repo.owner}/${repo.name}`
          const repoPrs = d.open_prs.filter((pr) => pr.repo === key)
          const passedRuns = repoPrs.filter((pr) => pr.latest_status === 'passed').length
          const passRate = repoPrs.length > 0 ? `${Math.round((passedRuns / repoPrs.length) * 100)}%` : '—'
          return (
            <div key={key} onClick={() => onOpenRepo(repo.owner, repo.name)} className='list-row'>
              <span style={{ width: 130 }}>
                <span className='inline-flex items-center gap-1'>
                  {repoPrs.length === 0 && (
                    <span className='font-mono text-3xs text-faint'>no open PRs</span>
                  )}
                  {repoPrs.map((pr) => (
                    <span
                      key={pr.pr_number}
                      style={{
                        width: 11, height: 11, borderRadius: '50%', flexShrink: 0,
                        background:
                          pr.latest_status === 'passed' ? 'var(--pass-bright)'
                          : pr.latest_status === 'failed' ? 'var(--fail-solid)'
                          : pr.latest_status === 'running' ? 'var(--indigo-500)'
                          : 'var(--ink-400)',
                        boxShadow: pr.latest_status === 'running' ? '0 0 0 3px rgba(109,99,240,0.22)' : 'none',
                      }}
                      title={`#${pr.pr_number} ${pr.latest_status}`}
                    />
                  ))}
                </span>
              </span>
              <div className='flex-1 min-w-0'>
                <div className='font-mono text-md text-ink'>{repo.owner}/{repo.name}</div>
              </div>
              <span className='font-mono text-sm text-muted text-right' style={{ width: 72 }}>{passRate}</span>
              <span className='font-mono text-faint text-right' style={{ width: 20 }}>→</span>
            </div>
          )
        })}
      </div>

      {showAdd && <AddRepoModal onClose={() => setShowAdd(false)} />}
    </div>
  )
}

function AddRepoModal({ onClose }: { onClose: () => void }) {
  return (
    <div onClick={onClose} className='modal-overlay'>
      <div onClick={(e) => e.stopPropagation()} className='modal-box'>
        <div className='flex items-center gap-3 px-6 py-5 border-b'>
          <div className='flex-1'>
            <div className='font-mono text-lg font-medium text-ink'>Add a repository</div>
            {/* STUB: needs GitHub App repo picker — see /api/admin/repos */}
            <div className='font-serif text-base text-muted mt-1'>
              Link a GitHub repository to start running your scene specs on every push.
            </div>
          </div>
          <button onClick={onClose} className='btn-close'>✕</button>
        </div>
        <div className='p-6'>
          <p className='font-serif text-base text-muted' style={{ margin: 0 }}>
            Adding repositories via UI is coming soon. For now, use the admin API:
          </p>
          <pre className='font-mono text-sm bg-code' style={{ padding: '12px 14px', borderRadius: 'var(--radius-sm)', marginTop: 12 }}>
            {`POST /api/admin/repos\n{ "owner": "acme", "name": "my-app" }`}
          </pre>
        </div>
        <div className='flex justify-end px-6 py-4 border-t'>
          <button onClick={onClose} className='btn btn-md btn-secondary'>Close</button>
        </div>
      </div>
    </div>
  )
}
