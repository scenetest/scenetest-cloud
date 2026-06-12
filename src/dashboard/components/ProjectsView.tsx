import { useState } from 'preact/hooks'
import { useOverview } from '../hooks/useOverview.ts'
import { Button } from './Button.tsx'

interface Props {
  onOpenRepo: (owner: string, name: string) => void
}

export function ProjectsView({ onOpenRepo }: Props) {
  const q = useOverview()
  const [showAdd, setShowAdd] = useState(false)

  if (q.isPending) return <div class='page-shell'><p class='font-mono text-muted'>Loading…</p></div>
  if (q.isError) return <div class='page-shell'><p class='font-mono text-fail'>Failed to load repos.</p></div>

  const d = q.data

  return (
    <div class='page-shell'>
      <div class='flex items-baseline justify-between mb-2'>
        <h1 class='font-mono text-2xl font-medium tracking-hero text-ink m-0'>Projects</h1>
        <Button variant='primary' size='lg' onClick={() => setShowAdd(true)}>+ Add project</Button>
      </div>
      <p class='font-serif text-lg text-muted mt-0 mb-8'>
        Every GitHub repository Scenetest is watching. Scan the left column for PRs that need attention.
      </p>

      <div class='list-panel bg-paper'>
        <div class='table-head'>
          <span class='w-32'>Open PRs</span>
          <span class='flex-1'>Repository</span>
          <span class='w-18 text-right'>Pass · 7d</span>
          <span class='w-5'></span>
        </div>
        {d.repos.length === 0 && (
          <div class='list-row cursor-default'>
            <span class='font-serif text-base text-muted'>No repos yet. Click "Add project" to get started.</span>
          </div>
        )}
        {d.repos.map((repo) => {
          const key = `${repo.owner}/${repo.name}`
          const repoPrs = d.open_prs.filter((pr) => pr.repo === key)
          const passedRuns = repoPrs.filter((pr) => pr.latest_status === 'passed').length
          const passRate = repoPrs.length > 0 ? `${Math.round((passedRuns / repoPrs.length) * 100)}%` : '—'
          return (
            <div key={key} onClick={() => onOpenRepo(repo.owner, repo.name)} class='list-row'>
              <span class='w-32 inline-flex items-center gap-1'>
                {repoPrs.length === 0 && <span class='font-mono text-3xs text-faint'>no open PRs</span>}
                {repoPrs.map((pr) => (
                  <span
                    key={pr.pr_number}
                    class={`w-2.5 h-2.5 rounded-full shrink-0 ${
                      pr.latest_status === 'passed'  ? 'bg-pass'
                      : pr.latest_status === 'failed'  ? 'bg-fail'
                      : pr.latest_status === 'running' ? 'bg-indigo-500'
                      : 'bg-faint'
                    }`}
                    style={pr.latest_status === 'running' ? { boxShadow: '0 0 0 3px rgba(109,99,240,0.22)' } : {}}
                    title={`#${pr.pr_number} ${pr.latest_status}`}
                  />
                ))}
              </span>
              <div class='flex-1 min-w-0 font-mono text-md text-ink'>{repo.owner}/{repo.name}</div>
              <span class='w-18 font-mono text-sm text-muted text-right'>{passRate}</span>
              <span class='w-5 font-mono text-faint text-right'>→</span>
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
    <div onClick={onClose} class='modal-overlay'>
      <div onClick={(e) => e.stopPropagation()} class='modal-box'>
        <div class='flex items-center gap-3 px-6 py-5 border-b border-border'>
          <div class='flex-1'>
            <div class='font-mono text-lg font-medium text-ink'>Add a repository</div>
            {/* STUB: needs GitHub App repo picker — see /api/admin/repos */}
            <div class='font-serif text-base text-muted mt-1'>
              Link a GitHub repository to start running your scene specs on every push.
            </div>
          </div>
          <button onClick={onClose} class='bg-transparent border-0 text-faint cursor-pointer font-mono text-lg leading-none'>✕</button>
        </div>
        <div class='p-6'>
          <p class='font-serif text-base text-muted m-0'>
            Adding repositories via UI is coming soon. For now, use the admin API:
          </p>
          <pre class='font-mono text-sm bg-code rounded-sm mt-3 p-3.5 m-0'>
            {`POST /api/admin/repos\n{ "owner": "acme", "name": "my-app" }`}
          </pre>
        </div>
        <div class='flex justify-end px-6 py-4 border-t border-border'>
          <Button variant='secondary' size='md' onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  )
}
