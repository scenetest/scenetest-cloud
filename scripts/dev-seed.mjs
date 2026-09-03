// Fill the local D1 with something to look at: two watched repos, a few pull
// requests, and real runs from the stub runner. Everything goes through the
// worker's own routes — dev sign-in, the admin repo route, signed webhook
// deliveries — so the seeded state is the state a real delivery would produce.
//
// Run it against an already-running `pnpm dev`:  pnpm dev:seed
import { apiJson, devSignIn, pullRequestPayload, randomSha, sendWebhook, sleep, waitForServer, BASE } from './lib/dev.mjs'

const REPOS = [
  { owner: 'scenetest-demo', name: 'storefront' },
  { owner: 'scenetest-demo', name: 'checkout' },
]

// storefront gets pull requests and runs; checkout stays empty on purpose, so
// the projects list shows a repo mid-onboarding next to a live one.
const PULL_REQUESTS = [
  { prNumber: 42, title: 'Add express checkout' },
  { prNumber: 43, title: 'Fix flaky login scene' },
]

export async function seed({ log = console.log } = {}) {
  const cookie = await devSignIn('dev')
  log('· signed in as dev')

  for (const repo of REPOS) {
    await apiJson('/api/admin/repos', { cookie, method: 'POST', body: repo })
    log(`· watching ${repo.owner}/${repo.name}`)
  }

  const repo = `${REPOS[0].owner}/${REPOS[0].name}`
  for (const pr of PULL_REQUESTS) {
    await sendWebhook(pullRequestPayload({
      repo,
      prNumber: pr.prNumber,
      action: 'opened',
      headSha: randomSha(),
      title: pr.title,
    }))
    log(`· opened ${repo}#${pr.prNumber} — ${pr.title}`)
  }
  await waitForRuns(cookie, REPOS[0], 2)

  // A second push on the same pull request: run history on the PR page, and
  // the latest-wins path that cancels the run still in flight.
  await sendWebhook(pullRequestPayload({
    repo,
    prNumber: PULL_REQUESTS[0].prNumber,
    action: 'synchronize',
    headSha: randomSha(),
    title: PULL_REQUESTS[0].title,
  }))
  log(`· pushed a second commit to ${repo}#${PULL_REQUESTS[0].prNumber}`)
  await waitForRuns(cookie, REPOS[0], 3)

  // Every full stub run fails, because one of its fabricated scenes always
  // fails. Re-run PR 43 over the scenes that pass, so the dashboard shows a
  // green run next to the red ones. Scene ids come from FAKE_SCENES in
  // src/worker/runner/stub.ts; an id that no longer matches just runs nothing.
  await apiJson('/api/debug/stub-run', {
    cookie,
    method: 'POST',
    body: {
      repo,
      prNumber: PULL_REQUESTS[1].prNumber,
      title: PULL_REQUESTS[1].title,
      subset: [
        'specs/login.scene.ts:logs in with valid credentials',
        'specs/login.scene.ts:rejects bad password',
        'specs/dashboard.scene.ts:renders metrics widgets',
      ],
    },
  })
  log(`· re-ran the passing scenes on ${repo}#${PULL_REQUESTS[1].prNumber}`)
  await waitForRuns(cookie, REPOS[0], 4)

  return { repo, prNumber: PULL_REQUESTS[0].prNumber }
}

// The stub runner emits its events in the background, so a freshly seeded run
// is 'queued' for a moment. Wait for the runs to settle rather than leaving
// the dashboard mid-flight on first load.
async function waitForRuns(cookie, { owner, name }, expected, maxMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const data = await apiJson(`/api/cloud/repos/${owner}/${name}`, { cookie })
    const runs = data.recent_runs ?? []
    const settled = runs.filter((r) => ['passed', 'failed', 'cancelled'].includes(r.status))
    if (settled.length >= expected) return
    await sleep(400)
  }
}

if (import.meta.filename === process.argv[1]) {
  if (!(await waitForServer(5_000))) {
    console.error(`No worker on ${BASE}. Start one with \`pnpm dev\` first.`)
    process.exit(1)
  }
  const { repo, prNumber } = await seed()
  console.log(`\nSeeded. Open ${BASE}/repo/${repo}/pr/${prNumber}`)
}
