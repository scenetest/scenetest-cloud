// Fire a signed pull_request delivery at the local worker — what GitHub would
// send on a push, without a public tunnel or a real webhook secret.
//
//   pnpm dev:webhook                                    # push to the seeded PR
//   pnpm dev:webhook --repo owner/name --pr 7 --action opened --title 'Try it'
//
// Actions: synchronize (default), opened, reopened, closed. --sha pins the head
// commit; without it every delivery invents a new one.
import { apiJson, devSignIn, pullRequestPayload, randomSha, requireServer, sendWebhook, BASE } from './lib/dev.mjs'

// Also the option list: parseArgs rejects any flag without a key here.
const DEFAULTS = { repo: 'scenetest-demo/storefront', pr: 42, action: 'synchronize', title: null, sha: null }

function parseArgs(argv) {
  const args = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '')
    const value = argv[i + 1]
    if (!(key in args)) {
      console.error(`Unknown option: ${argv[i]}. Options: --repo --pr --action --title --sha`)
      process.exit(1)
    }
    args[key] = key === 'pr' ? Number(value) : value
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
await requireServer()

const headSha = args.sha ?? randomSha()
const result = await sendWebhook(pullRequestPayload({
  repo: args.repo,
  prNumber: args.pr,
  action: args.action,
  headSha,
  title: args.title ?? (await currentTitle(args.repo, args.pr)),
}))

// Every real delivery carries the pull request's title, and the worker stores
// what it is sent — so a push with no --title reuses the title already on
// record instead of clearing it.
async function currentTitle(repo, prNumber) {
  try {
    const cookie = await devSignIn()
    const { open_prs } = await apiJson(`/api/cloud/repos/${repo}`, { cookie })
    const pr = open_prs.find((p) => p.pr_number === prNumber)
    if (pr?.title) return pr.title
  } catch {}
  return `Local dev PR #${prNumber}`
}

// The worker answers 200 for deliveries it chose to ignore (an unwatched repo,
// an action with no run behind it) — the result field says which it was.
console.log(`${args.action} ${args.repo}#${args.pr} @ ${headSha.slice(0, 7)} → ${result.result}`)
console.log(`${BASE}/repo/${args.repo}/pr/${args.pr}`)
