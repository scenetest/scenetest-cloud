// `pnpm dev` — migrate the local D1, start wrangler dev and the dashboard
// build, then seed demo data on a fresh database. docs/setup.md is the
// reference for what that gets you.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { apiJson, devSignIn, devVarArgs, wrangler, waitForServer, BASE, DEV_PORT, REPO_ROOT, WRANGLER } from './lib/dev.mjs'
import { seed } from './dev-seed.mjs'

const noSeed = process.argv.includes('--no-seed')

// wrangler dev fails to start if the assets directory is missing, and on a
// fresh clone the dashboard build has not written it yet.
mkdirSync(join(REPO_ROOT, 'dist/dashboard'), { recursive: true })

console.log('· applying migrations to the local D1')
wrangler(['d1', 'migrations', 'apply', 'DB', '--local'], { stdio: ['ignore', 'ignore', 'inherit'] })

const workerCmd = [WRANGLER, 'dev', '--port', String(DEV_PORT), ...devVarArgs()].join(' ')
const dashboardCmd = `${join(REPO_ROOT, 'node_modules/.bin/vite')} build --watch`

const child = spawn(
  join(REPO_ROOT, 'node_modules/.bin/concurrently'),
  ['-k', '-n', 'worker,dashboard', '-c', 'blue,magenta', workerCmd, dashboardCmd],
  { cwd: REPO_ROOT, stdio: 'inherit' },
)
child.on('exit', (code) => process.exit(code ?? 0))

if (await waitForServer()) {
  if (!noSeed) await seedIfEmpty()
  banner()
}

async function seedIfEmpty() {
  try {
    const cookie = await devSignIn()
    const { repos } = await apiJson('/api/admin/repos', { cookie })
    if (repos.length > 0) {
      console.log(`\n· ${repos.length} watched repo(s) already in the local D1 — skipping the seed`)
      return
    }
    console.log('\n· seeding demo data')
    await seed(cookie)
  } catch (err) {
    console.error(`\n· seeding failed: ${err.message}`)
    console.error('  The worker is still running; retry with `pnpm dev:seed`.')
  }
}

function banner() {
  console.log(`
  scenetest cloud — local dev

    dashboard    ${BASE}
    sign in      click "Sign in as dev" — no GitHub account needed
    reseed       pnpm dev:seed
    fake a push  pnpm dev:webhook
`)
}
