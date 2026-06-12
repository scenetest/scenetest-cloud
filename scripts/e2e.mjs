#!/usr/bin/env node
// End-to-end check: boots the real worker (wrangler dev + workerd) against a
// throwaway D1, then exercises the seams a unit test can't reach — auth
// redirects, webhook HMAC + triggering, the stub runner writing through to
// SSE, the dashboard shell + widget asset, command validation, and the
// latest-wins cancellation.
//
// Hermetic by construction: state lives in a temp --persist-to dir, secrets
// are inline --var values invented below, and the port is off to the side.
// Your .dev.vars and .wrangler/state are never read or written.
//
// Run it with `pnpm e2e` after touching src/worker/**, src/dashboard/**, or
// migrations/**. (When the build-pipeline stages exist, that sentence becomes
// this stage's watch globs.)

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 8970
const BASE = `http://127.0.0.1:${PORT}`
const WRANGLER = join(import.meta.dirname, '../node_modules/.bin/wrangler')
const SESSION_SECRET = 'e2e-session-secret'
const WEBHOOK_SECRET = 'e2e-webhook-secret'

// ---------- tiny check harness ----------------------------------------------

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures.push(name)
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------- crypto helpers (mirror cookies.ts / GitHub's webhook HMAC) ------

const enc = new TextEncoder()
const b64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)))
}

async function forgeSessionCookie() {
  const payload = JSON.stringify({ sub: 1, login: 'e2e', exp: Math.floor(Date.now() / 1000) + 3600 })
  const payloadB64 = b64url(enc.encode(payload))
  const sig = await hmac(SESSION_SECRET, payloadB64)
  return `session=${payloadB64}.${b64url(sig)}`
}

async function signWebhook(body) {
  const mac = await hmac(WEBHOOK_SECRET, body)
  return 'sha256=' + Buffer.from(mac).toString('hex')
}

// ---------- wrangler plumbing ------------------------------------------------

function d1(persistDir, args) {
  return execFileSync(
    WRANGLER,
    ['d1', ...args, '--local', '--persist-to', persistDir],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

function d1Query(persistDir, sql) {
  const out = d1(persistDir, ['execute', 'DB', '--json', '--command', sql])
  return JSON.parse(out)[0].results
}

async function waitForServer(child, maxMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early (code ${child.exitCode})`)
    try {
      await fetch(`${BASE}/api/me`)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  throw new Error('wrangler dev did not become ready in time')
}

// Read an SSE stream, collecting `data:` payloads until the server closes it
// (terminal run) or maxMs passes. Returns parsed events.
async function collectSse(path, cookie, maxMs = 8000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), maxMs)
  const events = []
  try {
    const res = await fetch(BASE + path, { headers: { cookie }, signal: ctrl.signal })
    if (!res.ok) return { status: res.status, events }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)))
      }
    }
    return { status: res.status, events }
  } catch {
    return { status: 0, events } // aborted on timeout; return what arrived
  } finally {
    clearTimeout(timer)
  }
}

// ---------- main -------------------------------------------------------------

const persistDir = mkdtempSync(join(tmpdir(), 'scenetest-e2e-'))
let server = null
let agent = null

async function main() {
  console.log('· building dashboard assets')
  execFileSync('node', [join(import.meta.dirname, '../node_modules/vite/bin/vite.js'), 'build'],
    { stdio: ['ignore', 'ignore', 'inherit'] })

  console.log('· migrating throwaway D1 and seeding a watched repo')
  d1(persistDir, ['migrations', 'apply', 'DB'])
  d1Query(persistDir, "INSERT INTO allowed_user (github_id, github_login, added_at) VALUES (1, 'e2e', 0)")
  d1Query(persistDir, "INSERT INTO watched_repo (owner, name, added_at, added_by) VALUES ('demo', 'watched', 0, 1)")

  // Seed a PR + box + run so the script can play the box itself: connect the
  // coordinator's WebSocket channel with this token and speak the box wire
  // format, with no provider involved.
  const boxToken = 'e2e-box-token'
  const boxTokenHash = Buffer.from(
    await crypto.subtle.digest('SHA-256', enc.encode(boxToken)),
  ).toString('hex')
  d1Query(persistDir,
    "INSERT INTO prs (repo, pr_number, head_sha, base_ref, state, opened_at, updated_at) VALUES ('demo/watched', 9, 'wsbox1', 'main', 'open', 0, 0)")
  d1Query(persistDir,
    `INSERT INTO boxes (id, repo, pr_number, head_sha, status, bearer_token_hash, created_at) VALUES ('e2e-box-1', 'demo/watched', 9, 'wsbox1', 'ready', '${boxTokenHash}', 0)`)
  d1Query(persistDir,
    "INSERT INTO runs (id, repo, pr_number, head_sha, trigger, status, box_id) VALUES ('e2e-ws-run', 'demo/watched', 9, 'wsbox1', 'manual', 'queued', 'e2e-box-1')")

  // A second PR + box for the real box agent (infra/box/agent.mjs), spawned
  // below in test mode — separate so its channel doesn't fight the inline
  // box-protocol checks. Starts 'provisioning'; the agent must flip it.
  d1Query(persistDir,
    "INSERT INTO prs (repo, pr_number, head_sha, base_ref, state, opened_at, updated_at) VALUES ('demo/watched', 10, 'agbox1', 'main', 'open', 0, 0)")
  d1Query(persistDir,
    `INSERT INTO boxes (id, repo, pr_number, head_sha, status, bearer_token_hash, created_at) VALUES ('e2e-box-2', 'demo/watched', 10, 'agbox1', 'provisioning', '${boxTokenHash}', 0)`)
  d1Query(persistDir,
    "INSERT INTO runs (id, repo, pr_number, head_sha, trigger, status, box_id) VALUES ('e2e-agent-run', 'demo/watched', 10, 'agbox1', 'manual', 'queued', 'e2e-box-2')")

  console.log('· starting wrangler dev')
  server = spawn(WRANGLER, [
    'dev', '--port', String(PORT), '--persist-to', persistDir,
    '--var', `SESSION_SECRET:${SESSION_SECRET}`,
    '--var', `GITHUB_WEBHOOK_SECRET:${WEBHOOK_SECRET}`,
    '--var', 'GITHUB_OAUTH_CLIENT_SECRET:e2e-dummy',
    '--var', 'ENABLE_DEBUG_ROUTES:1',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let serverErr = ''
  server.stderr.on('data', (d) => { serverErr += d })
  await waitForServer(server)

  const cookie = await forgeSessionCookie()
  const j = (res) => res.json()

  // --- auth seams ---
  console.log('· auth')
  check('SPA shell is public', (await fetch(BASE + '/')).status === 200)
  check('/api/me anonymous → 401', (await fetch(BASE + '/api/me')).status === 401)
  const me = await fetch(BASE + '/api/me', { headers: { cookie } })
  check('/api/me with forged session → 200', me.status === 200 && (await j(me)).github_login === 'e2e')

  // --- webhook seams ---
  console.log('· webhook')
  const hook = async (event, body, { delivery, badSig } = {}) => {
    const raw = JSON.stringify(body)
    return fetch(BASE + '/webhook/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': delivery ?? crypto.randomUUID(),
        'x-hub-signature-256': badSig ? 'sha256=' + '0'.repeat(64) : await signWebhook(raw),
      },
      body: raw,
    })
  }
  const prPayload = (repo, n, sha) => ({
    action: 'opened', number: n,
    repository: { full_name: repo },
    pull_request: { state: 'open', head: { sha }, base: { ref: 'main', sha: 'base000' } },
  })

  check('bad signature → 401', (await hook('ping', {}, { badSig: true })).status === 401)
  check('ping → ignored', (await j(await hook('ping', { zen: 'ok' }))).result === 'ignored:ping')
  const dupId = crypto.randomUUID()
  await hook('ping', { zen: 'ok' }, { delivery: dupId })
  check('duplicate delivery → dropped', (await j(await hook('ping', { zen: 'ok' }, { delivery: dupId }))).result === 'duplicate')
  check('unwatched repo → ignored',
    (await j(await hook('pull_request', prPayload('demo/unwatched', 1, 'aaa1')))).result === 'ignored:unwatched-repo')

  const created = await j(await hook('pull_request', prPayload('demo/watched', 5, 'aaa2')))
  const webhookRunId = created.result?.startsWith('run-created:') ? created.result.slice('run-created:'.length) : null
  check('watched repo PR → run created', webhookRunId !== null, JSON.stringify(created))

  // --- watching a repo survives an unreachable/rate-limited GitHub lookup ---
  console.log('· add repo (resilient to GitHub lookup)')
  const added = await fetch(BASE + '/api/admin/repos', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ owner: 'demo', name: 'added-via-api' }),
  })
  check('add-repo returns 200 even when GitHub lookup fails', added.status === 200)
  const watchedRow = d1Query(persistDir,
    "SELECT COUNT(*) AS n FROM watched_repo WHERE owner = 'demo' AND name = 'added-via-api'")
  check('watched_repo row written regardless of GitHub', watchedRow[0].n === 1)
  // Casing differs from registration → still matches (NOCASE) and triggers.
  const addedHook = await j(await hook('pull_request', prPayload('demo/Added-Via-API', 2, 'addr01')))
  check('newly watched repo triggers a run (case-insensitive match)',
    addedHook.result?.startsWith('run-created:'), JSON.stringify(addedHook))

  // --- the run that webhook triggered, observed through SSE ---
  console.log('· stub run → SSE')
  const replay = await collectSse(`/api/runs/${webhookRunId}/events`, cookie)
  const types = replay.events.map((e) => e.type)
  check('SSE replays run:start first', types[0] === 'run:start')
  check('SSE reaches run:end (stream closed by terminal state)', types.includes('run:end'))
  check('scenes flowed through', types.filter((t) => t === 'scene:start').length === 4)

  // --- dashboard shell + widget + commands ---
  console.log('· dashboard')
  const anon = await fetch(`${BASE}/r/${webhookRunId}/dashboard`, { redirect: 'manual' })
  check('dashboard anonymous → login redirect with next',
    anon.status === 302 && (anon.headers.get('location') ?? '').includes('next=%2Fr%2F'))
  const page = await fetch(`${BASE}/r/${webhookRunId}/dashboard`, { headers: { cookie } })
  const html = await page.text()
  check('dashboard authed → shell referencing widget', page.status === 200 && html.includes('/run-dashboard.js'))
  const asset = await fetch(BASE + '/run-dashboard.js')
  check('widget asset served', asset.status === 200 && (await asset.text()).includes('shadow'))
  const cmdOk = await fetch(`${BASE}/api/runs/${webhookRunId}/commands`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'run:stop' }),
  })
  // No box is connected for this PR, so the coordinator queues it.
  check('valid protocol command → 202 accepted', cmdOk.status === 202)
  const cmdBad = await fetch(`${BASE}/api/runs/${webhookRunId}/commands`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'rm -rf' }),
  })
  check('garbage command → 400', cmdBad.status === 400)
  check('SSE with tampered session → 401',
    (await collectSse(`/api/runs/${webhookRunId}/events`, 'session=tampered.sig', 1500)).status === 401)

  // --- PR coordinator: the script plays the box over the WebSocket channel --
  console.log('· PR coordinator (box channel)')
  const wsUrl = (token) => `ws://127.0.0.1:${PORT}/api/boxes/e2e-box-1/channel?token=${token}`

  // Wrong token: the upgrade is refused, surfacing as an error/close event.
  const badWs = new WebSocket(wsUrl('wrong-token'))
  const badResult = await new Promise((resolve) => {
    badWs.addEventListener('open', () => resolve('open'))
    badWs.addEventListener('error', () => resolve('refused'))
    badWs.addEventListener('close', () => resolve('refused'))
  })
  check('box channel rejects a bad token', badResult === 'refused')

  // Command posted while no box is connected → queued, not delivered.
  const queuedCmd = await fetch(`${BASE}/api/runs/e2e-ws-run/commands`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'run:pause' }),
  })
  check('command with no box connected → 202 queued',
    queuedCmd.status === 202 && (await j(queuedCmd)).delivered === false)

  // Connect as the box; collect everything the coordinator sends.
  const box = new WebSocket(wsUrl(boxToken))
  const inbox = []
  box.addEventListener('message', (e) => inbox.push(JSON.parse(e.data)))
  await new Promise((resolve, reject) => {
    box.addEventListener('open', resolve)
    box.addEventListener('error', () => reject(new Error('box channel refused valid token')))
  })
  const waitInbox = async (pred, maxMs = 4000) => {
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      const hit = inbox.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 50))
    }
    return null
  }

  const flushed = await waitInbox((m) => m.kind === 'command')
  check('queued command flushed to box on connect', flushed?.command?.type === 'run:pause',
    JSON.stringify(inbox))

  // Command posted while connected → delivered live.
  const liveCmd = await fetch(`${BASE}/api/runs/e2e-ws-run/commands`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'run:resume' }),
  })
  check('command with box connected → 202 delivered',
    liveCmd.status === 202 && (await j(liveCmd)).delivered === true)
  check('live command arrived on the box socket',
    (await waitInbox((m) => m.command?.type === 'run:resume')) !== null, JSON.stringify(inbox))

  // Box streams events up the socket → coordinator writes through to D1 →
  // the SSE endpoint (which reads D1) replays them to viewers.
  box.send(JSON.stringify({
    kind: 'events', runId: 'e2e-ws-run',
    events: [
      { seq: 1, payload: { type: 'run:start', timestamp: Date.now(), sceneCount: 1 } },
      { seq: 2, payload: { type: 'scene:start', timestamp: Date.now(), name: 'ws scene', file: 'x.scene.ts', actors: ['A'] } },
    ],
  }))
  check('coordinator acked the events batch',
    (await waitInbox((m) => m.kind === 'ack' && m.count === 2)) !== null, JSON.stringify(inbox))
  const wsReplay = await collectSse('/api/runs/e2e-ws-run/events', cookie, 2500)
  check('box events reached viewers via D1 → SSE',
    wsReplay.events.some((e) => e.type === 'scene:start' && e.name === 'ws scene'))
  box.close()

  // --- the real box agent, spawned in test mode -----------------------------
  console.log('· box agent (infra/box/agent.mjs)')
  const agentWork = mkdtempSync(join(tmpdir(), 'scenetest-agent-'))
  // Queue a pipeline update and a command before the agent exists; both must
  // arrive via flush on connect, update first (FIFO). The update's stage
  // drops a marker file so we can see it actually executed, and its vector
  // must come back through /ready into boxes.realized_stages.
  const updateQueued = await fetch(`${BASE}/api/debug/box-update`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      boxId: 'e2e-box-2',
      headSha: 'agbox1',
      vector: { setup: 'hash-setup-1' },
      stages: [{ name: 'setup', run: 'touch stage-ran.marker' }],
    }),
  })
  check('debug box-update queued (no box connected yet)',
    updateQueued.status === 202 && (await j(updateQueued)).delivered === false)
  await fetch(`${BASE}/api/runs/e2e-agent-run/commands`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'run:pause' }),
  })
  check('agent: ready endpoint rejects bad token',
    (await fetch(`${BASE}/api/boxes/e2e-box-2/ready`, {
      method: 'POST', headers: { authorization: 'Bearer wrong' },
    })).status === 401)

  agent = spawn('node', [join(import.meta.dirname, '../infra/box/agent.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SCENETEST_BOX_ID: 'e2e-box-2',
      SCENETEST_REPO: 'demo/watched',
      SCENETEST_HEAD_SHA: 'agbox1',
      SCENETEST_INGEST_URL: BASE,
      SCENETEST_BEARER_TOKEN: boxToken,
      SCENETEST_WORK_DIR: agentWork,
      SCENETEST_LOCAL_PORT: '4998',
      SCENETEST_SKIP_CHECKOUT: '1',
      SCENETEST_NO_POWEROFF: '1',
    },
  })
  let agentLog = ''
  agent.stdout.on('data', (d) => { agentLog += d })
  agent.stderr.on('data', (d) => { agentLog += d })

  const waitFor = async (fn, maxMs = 6000) => {
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      if (await fn()) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  check('agent connected its channel',
    await waitFor(() => agentLog.includes('channel connected')), agentLog)
  check('agent ran the queued pipeline stage',
    await waitFor(() => existsSync(join(agentWork, 'stage-ran.marker'))), agentLog)
  check('agent received the queued command (flush on connect)',
    await waitFor(() => {
      try { return readFileSync(join(agentWork, 'e2e-agent-run.commands.jsonl'), 'utf8').includes('run:pause') }
      catch { return false }
    }), agentLog)

  // The scenes CLI on a box reports to the agent's local ingest; the agent
  // relays up the channel and the coordinator writes through to D1/SSE.
  const localIngest = await fetch('http://127.0.0.1:4998/events/e2e-agent-run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ payload: { type: 'run:start', timestamp: Date.now(), sceneCount: 1 } }] }),
  })
  check('agent local ingest accepts and relays', localIngest.status === 202 && (await j(localIngest)).relayed === true)
  const agentReplay = await collectSse('/api/runs/e2e-agent-run/events', cookie, 2500)
  check('agent-relayed event reached viewers via D1 → SSE',
    agentReplay.events.some((e) => e.type === 'run:start'))
  agent.kill('SIGTERM')

  // A failed pipeline stage retires the box (its runs cancel; reaper would
  // sweep the droplet). Reuses box 1 — the inline section is done with it.
  const failReady = await fetch(`${BASE}/api/boxes/e2e-box-1/ready`, {
    method: 'POST',
    headers: { authorization: `Bearer ${boxToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ok: false, failed_stage: 'db' }),
  })
  check('failed stage report → box retired', (await j(failReady)).retired === true)

  // --- latest-wins: second push retires the box and cancels run 1 -----------
  // Timing assumption: the stub batch takes ≥600ms (5 × 120ms action sleeps),
  // and the second trigger lands within ~100ms of the first returning — so
  // run 1 is mid-flight when its box is retired.
  console.log('· latest-wins cancellation')
  const stubRun = async () => (await j(await fetch(BASE + '/api/debug/stub-run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prNumber: 1 }),
  }))).runId
  const run1 = await stubRun()
  const run2 = await stubRun()
  await collectSse(`/api/runs/${run2}/events`, cookie) // closes when run2 is terminal
  await new Promise((r) => setTimeout(r, 300)) // let run1's bailing loop settle

  const statuses = d1Query(persistDir,
    `SELECT id, status FROM runs WHERE id IN ('${run1}', '${run2}')`)
  const s = Object.fromEntries(statuses.map((r) => [r.id, r.status]))
  check('first run cancelled when box rebuilt', s[run1] === 'cancelled', `got ${s[run1]}`)
  check('second run reached its verdict', s[run2] === 'failed', `got ${s[run2]}`) // stub's checkout scene always fails
  const live = d1Query(persistDir,
    "SELECT COUNT(*) AS n FROM boxes WHERE repo = 'demo/repo' AND pr_number = 1 AND status != 'destroyed'")
  check('exactly one live box per PR', live[0].n === 1, `got ${live[0].n}`)
  const agentBox = d1Query(persistDir,
    "SELECT status, realized_stages FROM boxes WHERE id = 'e2e-box-2'")
  check('agent flipped its box provisioning → ready (via update)',
    agentBox[0].status === 'ready', `got ${agentBox[0].status}`)
  check('realized stage vector stored from the agent report',
    agentBox[0].realized_stages === '{"setup":"hash-setup-1"}', `got ${agentBox[0].realized_stages}`)
  const failedBox = d1Query(persistDir,
    "SELECT b.status, r.status AS run_status FROM boxes b JOIN runs r ON r.box_id = b.id WHERE b.id = 'e2e-box-1'")
  check('failed-stage box destroyed and its run cancelled',
    failedBox[0].status === 'destroyed' && failedBox[0].run_status === 'cancelled',
    JSON.stringify(failedBox[0]))

  if (failures.length > 0 && serverErr) {
    console.error('\n--- wrangler dev stderr (tail) ---\n' + serverErr.split('\n').slice(-20).join('\n'))
  }
}

main()
  .catch((err) => {
    failures.push('script error')
    console.error('script error:', err)
  })
  .finally(() => {
    if (agent && agent.exitCode === null) agent.kill('SIGKILL')
    if (server && server.exitCode === null) server.kill('SIGTERM')
    rmSync(persistDir, { recursive: true, force: true })
    console.log(`\n${passed} passed, ${failures.length} failed`)
    process.exit(failures.length > 0 ? 1 : 0)
  })
