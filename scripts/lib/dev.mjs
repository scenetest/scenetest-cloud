// Shared plumbing for the local dev scripts (dev.mjs, dev-seed.mjs,
// dev-webhook.mjs). Everything here talks to a `wrangler dev` worker on
// DEV_PORT and its local D1, and nothing here is used by the deployed worker.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const REPO_ROOT = join(import.meta.dirname, '../..')
export const WRANGLER = join(REPO_ROOT, 'node_modules/.bin/wrangler')
export const DEV_PORT = Number(process.env.SCENETEST_DEV_PORT ?? 8787)
export const BASE = `http://127.0.0.1:${DEV_PORT}`
const DEV_VARS_PATH = join(REPO_ROOT, '.dev.vars')

// Fixed, not generated: a stable SESSION_SECRET keeps your dev session cookie
// valid across restarts, and a stable webhook secret lets `pnpm dev:webhook`
// sign payloads without reading any state. Both only ever reach a local
// wrangler dev; anything in .dev.vars wins over them (see devVarArgs).
const DEV_VAR_DEFAULTS = {
  SESSION_SECRET: 'local-dev-session-secret',
  GITHUB_WEBHOOK_SECRET: 'local-dev-webhook-secret',
  ENABLE_DEBUG_ROUTES: '1',
}

let devVarsCache = null

function readDevVars() {
  if (devVarsCache) return devVarsCache
  if (!existsSync(DEV_VARS_PATH)) return (devVarsCache = {})
  const vars = {}
  for (const line of readFileSync(DEV_VARS_PATH, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const value = m[2].trim().replace(/^["'](.*)["']$/, '$1')
    if (value) vars[m[1]] = value
  }
  return (devVarsCache = vars)
}

// `--var` arguments for the dev defaults the developer has not set themselves.
// A real .dev.vars entry always wins, so a setup wired to a real GitHub App
// keeps working.
export function devVarArgs() {
  const own = readDevVars()
  return Object.entries(DEV_VAR_DEFAULTS)
    .filter(([k]) => !own[k])
    .flatMap(([k, v]) => ['--var', `${k}:${v}`])
}

export function devVar(name) {
  return readDevVars()[name] ?? DEV_VAR_DEFAULTS[name]
}

export function wrangler(args, opts = {}) {
  return execFileSync(WRANGLER, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  })
}

export async function waitForServer(maxMs = 60_000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE}/api/config`)
      if (res.ok) return true
    } catch {}
    await sleep(300)
  }
  return false
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// For the scripts that act on a worker somebody else started.
export async function requireServer() {
  if (await waitForServer(5_000)) return
  console.error(`No worker on ${BASE}. Start one with \`pnpm dev\` first.`)
  process.exit(1)
}

// ---------- worker calls ------------------------------------------------------

// Sign in through /auth/dev-login (ENABLE_DEBUG_ROUTES only) and return the
// session cookie the browser would get.
export async function devSignIn(login = 'dev') {
  const res = await fetch(`${BASE}/auth/dev-login?login=${encodeURIComponent(login)}`, {
    redirect: 'manual',
  })
  if (res.status !== 302) {
    throw new Error(`dev-login returned ${res.status} — is ENABLE_DEBUG_ROUTES set for this worker?`)
  }
  const setCookie = res.headers.get('set-cookie') ?? ''
  const token = /(?:^|;\s*)session=([^;]*)/.exec(setCookie)?.[1]
  if (!token) throw new Error('dev-login set no session cookie')
  return `session=${token}`
}

export async function apiJson(path, { cookie, method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`)
  return json
}

// ---------- webhook signing (mirrors GitHub's X-Hub-Signature-256) -----------

const enc = new TextEncoder()

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  return Buffer.from(new Uint8Array(mac)).toString('hex')
}

export function randomSha() {
  return Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
}

export function pullRequestPayload({ repo, prNumber, action, headSha, title }) {
  return {
    action,
    number: prNumber,
    repository: { full_name: repo },
    pull_request: {
      state: action === 'closed' ? 'closed' : 'open',
      title,
      head: { sha: headSha },
      base: { ref: 'main', sha: randomSha() },
    },
  }
}

// POST a signed pull_request event at the local worker — the same path a real
// GitHub delivery takes, with no tunnel.
export async function sendWebhook(payload) {
  const body = JSON.stringify(payload)
  const signature = 'sha256=' + (await hmacHex(devVar('GITHUB_WEBHOOK_SECRET'), body))
  const res = await fetch(`${BASE}/webhook/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-github-delivery': crypto.randomUUID(),
      'x-hub-signature-256': signature,
    },
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`webhook -> ${res.status} ${text.slice(0, 200)}`)
  return JSON.parse(text)
}
