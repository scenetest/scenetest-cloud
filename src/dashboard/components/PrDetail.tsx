import { useLocation } from 'preact-iso'
import { useEffect, useRef } from 'preact/hooks'
import { mountDashboard } from '@scenetest/dashboard'
import { useRepo } from '../hooks/useRepo.ts'
import { paths } from '../lib/paths.ts'
import { createCloudPrTransport } from '../lib/cloudTransport.ts'

interface Props {
  owner: string
  name: string
  number: string
}

// The PR page: one page per pull request, the unit of work. The dashboard
// widget mounts on the PR-anchored transport — one run-blind stream of the
// whole PR's events — and owns run browsing/selection internally. See
// docs/design/per-pr-dashboard.md.
export function PrDetail({ owner, name, number }: Props) {
  const prNumber = Number(number)
  const { route } = useLocation()
  const q = useRepo(owner, name)
  const back = () => route(paths.repo(owner, name))
  const pr = q.data?.open_prs.find((p) => p.pr_number === prNumber) ?? null

  return (
    <div class='page-shell'>
      <button onClick={back} class='btn-back'>← {owner}/{name}</button>
      <h1 class='font-mono text-2xl font-medium tracking-hero text-ink m-0 mb-1'>
        {pr?.title ?? `PR #${prNumber}`}
      </h1>
      <p class='font-serif text-lg text-muted mt-0 mb-8'>
        #{prNumber}{pr ? ` · ${pr.base_ref}` : ''}
      </p>
      <DashboardMount owner={owner} name={name} prNumber={prNumber} />
    </div>
  )
}

// Mounts the @scenetest/dashboard widget (its own shadow root) into a plain
// node, on the PR transport. Re-mounts only when the PR changes; unmount tears
// down the transport subscription.
function DashboardMount({ owner, name, prNumber }: { owner: string; name: string; prNumber: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const handle = mountDashboard(ref.current, {
      transport: createCloudPrTransport(owner, name, prNumber),
    })
    return () => handle.unmount()
  }, [owner, name, prNumber])
  return <div ref={ref} class='card overflow-hidden' />
}
