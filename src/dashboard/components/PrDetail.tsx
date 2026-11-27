import { useLocation } from 'preact-iso'
import { useMemo } from 'preact/hooks'
import { Dashboard } from '@scenetest/dashboard'
import '@scenetest/dashboard/style.css'
import { useRepo } from '../hooks/useRepo.ts'
import { paths } from '../lib/paths.ts'
import { createCloudPrTransport } from '../lib/cloudTransport.ts'
import { PrReports } from './PrReports.tsx'

interface Props {
  owner: string
  name: string
  number: string
}

// The PR page: one page per pull request, the unit of work. The 0.13 dashboard
// is a plain Preact component rendering into the light DOM, and its tab routing
// rides on *this* app's preact-iso router: it mounts under the SPA's
// `/repo/:owner/:name/pr/:number/:view?` route and reads the matched `:view`
// from useRoute(), so tab clicks deep-link and survive reload without the widget
// touching the URL. The PR-anchored transport feeds it one run-blind stream of
// the whole PR's events. See docs/design/per-pr-dashboard.md.
export function PrDetail({ owner, name, number }: Props) {
  const prNumber = Number(number)
  const { route } = useLocation()
  const q = useRepo(owner, name)
  const back = () => route(paths.repo(owner, name))
  const pr = q.data?.open_prs.find((p) => p.pr_number === prNumber) ?? null

  // One transport per PR — memoized so a tab switch (which re-renders this
  // component but keeps it mounted) doesn't reopen the socket; a different PR
  // makes a fresh one.
  const transport = useMemo(
    () => createCloudPrTransport(owner, name, prNumber),
    [owner, name, prNumber],
  )

  return (
    <div class='page-shell'>
      <button onClick={back} class='btn-back'>← {owner}/{name}</button>
      <h1 class='font-mono text-2xl font-medium tracking-hero text-ink m-0 mb-1'>
        {pr?.title ?? `PR #${prNumber}`}
      </h1>
      <p class='font-serif text-lg text-muted mt-0 mb-8'>
        #{prNumber}{pr ? ` · ${pr.base_ref}` : ''}
      </p>
      {/* Static-analysis comparison (#25), painted by cloud code in the docs
          aesthetic — above the embedded terminal run pane. */}
      <PrReports owner={owner} name={name} prNumber={prNumber} />
      <div class='card overflow-hidden'>
        {/* basePath is the router mount the tab anchors point under (deep-linkable
            tabs); apiBase bases the Runner's server fetches on cloud's API, which
            lives elsewhere than the router. */}
        <Dashboard
          transport={transport}
          basePath={paths.pr(owner, name, prNumber)}
          apiBase={`/api/cloud/repos/${owner}/${name}/pr/${prNumber}`}
        />
      </div>
    </div>
  )
}
