#!/usr/bin/env node
// End-to-end check: boots the real worker (wrangler dev + workerd) against a
// throwaway D1, then exercises the seams a unit test can't reach — auth
// redirects, webhook HMAC + triggering, the stub runner driving the event
// log, the dashboard shell + widget asset, command validation, and the
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
  // The CLI opens the same SQLite file the dev server holds; under load
  // (CI) that can collide as SQLITE_BUSY. Transient by nature — retry.
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync(
        WRANGLER,
        ['d1', ...args, '--local', '--persist-to', persistDir],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (err) {
      if (attempt >= 5) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * attempt)
    }
  }
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

// Extract the raw session token value from a Cookie header string.
// The viewer WS route accepts ?session=<token> as a fallback for clients
// (like Node's global WebSocket) that cannot set request headers.
function sessionToken(cookie) {
  return (/(?:^|;\s*)session=([^;]*)/.exec(cookie) ?? [])[1] ?? ''
}

// Build a viewer WS URL, injecting the session token as ?session=.
function viewerWsUrl(path, cookie) {
  const sep = path.includes('?') ? '&' : '?'
  return `ws://127.0.0.1:${PORT}${path}${sep}session=${sessionToken(cookie)}`
}

// Connect a viewer WebSocket, collect { events, seqs } until `run:end` arrives
// or maxMs elapses.
async function collectWs(path, cookie, maxMs = 8000) {
  return new Promise((resolve) => {
    const events = []
    const seqs = []
    let resolved = false
    let opened = false
    const finish = (status) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      try { ws.close() } catch {}
      resolve({ status, events, seqs })
    }
    const timer = setTimeout(() => finish(0), maxMs)
    const ws = new WebSocket(viewerWsUrl(path, cookie))
    ws.addEventListener('open', () => { opened = true })
    ws.addEventListener('error', () => finish(opened ? 0 : 401))
    ws.addEventListener('close', (e) => finish(opened ? (e.code === 1000 ? 200 : 0) : 401))
    ws.addEventListener('message', (e) => {
      let frame
      try { frame = JSON.parse(e.data) } catch { return }
      if (frame.kind !== 'event') return
      seqs.push(frame.seq)
      let payload
      try { payload = JSON.parse(frame.payload) } catch { return }
      events.push(payload)
      if (payload?.type === 'run:end') setTimeout(() => finish(200), 100)
    })
  })
}

// Check whether a WS upgrade is accepted ('open') or refused ('refused').
async function wsStatus(path, cookie, maxMs = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { ws.close() } catch {}; resolve('timeout') }, maxMs)
    const ws = new WebSocket(viewerWsUrl(path, cookie))
    ws.addEventListener('open', () => { clearTimeout(timer); resolve('open') })
    ws.addEventListener('error', () => { clearTimeout(timer); resolve('refused') })
    ws.addEventListener('close', () => { clearTimeout(timer); resolve('refused') })
  })
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
  // A webhook-creation ping records its repo: the "wiring verified" signal
  // for project onboarding.
  await hook('ping', { zen: 'ok', repository: { full_name: 'demo/watched' } })
  const pingRow = d1Query(persistDir,
    "SELECT COUNT(*) AS n FROM webhook_deliveries WHERE event = 'ping' AND repo = 'demo/watched'")
  check('ping delivery attributed to its repo', pingRow[0].n === 1)
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
  const repoList = await j(await fetch(BASE + '/api/admin/repos', { headers: { cookie } }))
  check('watched repo listed regardless of GitHub',
    repoList.repos.some((r) => r.owner === 'demo' && r.name === 'added-via-api'))
  // Casing differs from registration → still matches (NOCASE) and triggers.
  const addedHook = await j(await hook('pull_request', prPayload('demo/Added-Via-API', 2, 'addr01')))
  check('newly watched repo triggers a run (case-insensitive match)',
    addedHook.result?.startsWith('run-created:'), JSON.stringify(addedHook))

  // --- the run that webhook triggered, observed through the viewer WebSocket --
  console.log('· stub run → viewer WS')
  const replay = await collectWs(`/api/runs/${webhookRunId}/ws`, cookie)
  const types = replay.events.map((e) => e.type)
  check('WS replays run:start first', types[0] === 'run:start')
  check('WS reaches run:end', types.includes('run:end'))
  check('scenes flowed through', types.filter((t) => t === 'scene:start').length === 4)
  check('no duplicate seq in replay', replay.seqs.length === new Set(replay.seqs).size)

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
  check('WS with tampered session → refused',
    (await wsStatus(`/api/runs/${webhookRunId}/ws`, 'session=tampered.sig')) === 'refused')

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

  // Box streams events up the socket → coordinator appends them to its SQLite
  // log → the viewer WS (which reads that log) replays them to viewers.
  box.send(JSON.stringify({
    kind: 'events', runId: 'e2e-ws-run',
    events: [
      { seq: 1, payload: { type: 'run:start', timestamp: Date.now(), sceneCount: 1 } },
      { seq: 2, payload: { type: 'scene:start', timestamp: Date.now(), name: 'ws scene', file: 'x.scene.ts', actors: ['A'] } },
    ],
  }))
  check('coordinator acked the events batch',
    (await waitInbox((m) => m.kind === 'ack' && m.count === 2)) !== null, JSON.stringify(inbox))

  // Viewer WS: replay from the object's log, then live events.
  const wsReplay = await collectWs('/api/runs/e2e-ws-run/ws', cookie, 2500)
  check('box events reached viewer via WS replay',
    wsReplay.events.some((e) => e.type === 'scene:start' && e.name === 'ws scene'))

  // --- overlap dedup: replay and live may both deliver the same seq ----------
  // Connect a new viewer, then push a fresh event. The viewer gets the new
  // event exactly once — either from fanout before replay reaches it, or from
  // replay; the client's seq filter drops any duplicate.
  console.log('· replay/live overlap dedup + reconnect')
  box.send(JSON.stringify({
    kind: 'events', runId: 'e2e-ws-run',
    events: [{ seq: 3, payload: { type: 'action:start', timestamp: Date.now(), actor: 'A', action: 'click', target: 'x' } }],
  }))
  await waitInbox((m) => m.kind === 'ack' && m.runId === 'e2e-ws-run' && m.count >= 1)

  // Full replay (sinceSeq=0): seq 1, 2, 3 — no duplicates.
  const full = await collectWs('/api/runs/e2e-ws-run/ws?sinceSeq=0', cookie, 2500)
  check('full replay delivers all three events', full.seqs.length >= 3, JSON.stringify(full.seqs))
  check('no duplicates in full replay', full.seqs.length === new Set(full.seqs).size)

  // Reconnect with sinceSeq=2: should only see seq 3, never seq 1 or 2.
  const partial = await collectWs('/api/runs/e2e-ws-run/ws?sinceSeq=2', cookie, 2500)
  check('sinceSeq=2 skips seq 1 and 2', partial.seqs.every((s) => s > 2), JSON.stringify(partial.seqs))
  check('sinceSeq=2 delivers seq 3', partial.seqs.includes(3))

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
      // The scenes command from pipeline.json rides the update. This stands
      // in for `scenetest --report-url $SCENETEST_REPORT_URL`: POST the
      // batched {events:[{seq,payload}]} envelope the 0.15 CLI sends, with a
      // run:end the agent settles the verdict from (1 failed → run failed).
      scenes: `curl -s -X POST "$SCENETEST_REPORT_URL" -H 'content-type: application/json' -d '{"events":[{"seq":0,"payload":{"type":"run:start","timestamp":1,"sceneCount":1}},{"seq":1,"payload":{"type":"run:end","timestamp":2,"duration":1,"summary":{"scenes":1,"completed":0,"failed":1}}}]}'`,
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
  // relays up the channel and the coordinator appends to its SQLite log.
  const localIngest = await fetch('http://127.0.0.1:4998/events/e2e-agent-run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ payload: { type: 'run:start', timestamp: Date.now(), sceneCount: 1 } }] }),
  })
  check('agent local ingest accepts and relays', localIngest.status === 202 && (await j(localIngest)).relayed === true)
  const agentReplay = await collectWs('/api/runs/e2e-agent-run/ws', cookie, 2500)
  check('agent-relayed event reached viewer via WS',
    agentReplay.events.some((e) => e.type === 'run:start'))

  // Dispatch a batch: the agent runs the scenes command from the update,
  // which POSTs its event batch to $SCENETEST_REPORT_URL (the agent's local
  // ingest); the agent relays the events and settles the verdict from run:end.
  await fetch(`${BASE}/api/debug/box-dispatch`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      boxId: 'e2e-box-2',
      run: { runId: 'e2e-agent-run', boxId: 'e2e-box-2', repo: 'demo/watched', prNumber: 10, headSha: 'agbox1', subset: null },
    }),
  })
  check('scenes command ran and its events relayed (run:end via report-url)',
    await waitFor(async () => {
      const replay = await collectWs('/api/runs/e2e-agent-run/ws', cookie, 1200)
      return replay.events.some((e) => e.type === 'run:end')
    }, 8000))
  check('agent settled the verdict from run:end (1 failing scene → failed)',
    await waitFor(async () => {
      const rows = d1Query(persistDir, "SELECT status FROM runs WHERE id = 'e2e-agent-run'")
      return rows[0].status === 'failed'
    }, 5000))
  agent.kill('SIGTERM')

  // A failed pipeline stage retires the box (its runs cancel; reaper would
  // sweep the droplet). Reuses box 1 — the inline section is done with it.
  const failReady = await fetch(`${BASE}/api/boxes/e2e-box-1/ready`, {
    method: 'POST',
    headers: { authorization: `Bearer ${boxToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ok: false, failed_stage: 'db' }),
  })
  check('failed stage report → box retired', (await j(failReady)).retired === true)

  // --- the add-a-project wizard's status checklist ---------------------------
  console.log('· repo setup status')
  check('status endpoint anonymous → 401',
    (await fetch(`${BASE}/api/admin/repos/demo/watched/status`)).status === 401)
  const st1 = await j(await fetch(`${BASE}/api/admin/repos/demo/watched/status`, { headers: { cookie } }))
  check('status: registered + webhook seen + first run present',
    st1.registered === true && st1.webhook.seen === true && st1.first_run != null,
    JSON.stringify(st1))
  check('status: pipeline not falsely active', st1.pipeline.state !== 'active', JSON.stringify(st1.pipeline))
  // A box that realized real (non-coarse) stages flips the pipeline check.
  d1Query(persistDir,
    `UPDATE boxes SET realized_stages = '{"deps":"d1","db":"d2","build":"d3"}'
      WHERE id = (SELECT id FROM boxes WHERE repo = 'demo/watched' ORDER BY created_at DESC, rowid DESC LIMIT 1)`)
  const st2 = await j(await fetch(`${BASE}/api/admin/repos/demo/watched/status`, { headers: { cookie } }))
  check('status: realized stages → pipeline active (from box evidence)',
    st2.pipeline.state === 'active' && st2.pipeline.source === 'box', JSON.stringify(st2.pipeline))

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
  await collectWs(`/api/runs/${run2}/ws`, cookie) // closes when run2 emits run:end
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

  // --- R2 durable artifacts: log in the object → archive → serve from R2 ----
  // The event log lives in the PR object's SQLite. At end of run the object
  // flushes it to a per-run R2 .jsonl; D1 never holds the log, so there is no
  // prune. We drive a log into a fresh PR's object over the box channel, then
  // archive it via the cron backstop and read it back.
  console.log('· R2 artifacts (archive → serve from R2)')
  d1Query(persistDir,
    "INSERT INTO prs (repo, pr_number, head_sha, base_ref, state, opened_at, updated_at) VALUES ('demo/watched', 11, 'artif1', 'main', 'open', 0, 0)")
  d1Query(persistDir,
    `INSERT INTO boxes (id, repo, pr_number, head_sha, status, bearer_token_hash, created_at) VALUES ('e2e-box-art', 'demo/watched', 11, 'artif1', 'ready', '${boxTokenHash}', 0)`)
  d1Query(persistDir,
    "INSERT INTO runs (id, repo, pr_number, head_sha, trigger, status, box_id) VALUES ('e2e-artifact-run', 'demo/watched', 11, 'artif1', 'manual', 'running', 'e2e-box-art')")

  // Drive the run's log into the PR object over its box channel.
  const artBox = new WebSocket(`ws://127.0.0.1:${PORT}/api/boxes/e2e-box-art/channel?token=${boxToken}`)
  const artInbox = []
  artBox.addEventListener('message', (e) => artInbox.push(JSON.parse(e.data)))
  await new Promise((resolve, reject) => {
    artBox.addEventListener('open', resolve)
    artBox.addEventListener('error', () => reject(new Error('art box channel refused')))
  })
  artBox.send(JSON.stringify({
    kind: 'events', runId: 'e2e-artifact-run',
    events: [
      { seq: 1, payload: { type: 'run:start', timestamp: 1, sceneCount: 1 } },
      { seq: 2, payload: { type: 'scene:start', timestamp: 1, name: 'artifact scene', file: 'a.scene.ts', actors: ['A'] } },
      { seq: 3, payload: { type: 'run:end', timestamp: 2, duration: 1, summary: { scenes: 1, completed: 1, failed: 0 } } },
    ],
  }))
  const artAck = await waitFor(() =>
    artInbox.some((m) => m.kind === 'ack' && m.runId === 'e2e-artifact-run' && m.count === 3))
  check('artifact run events acked by the coordinator', artAck, JSON.stringify(artInbox))

  check('run log anonymous → 401', (await fetch(`${BASE}/api/runs/e2e-artifact-run/log`)).status === 401)

  // Before archive: /log streams the live log straight from the object's SQLite.
  const logPre = await fetch(`${BASE}/api/runs/e2e-artifact-run/log`, { headers: { cookie } })
  const logPreText = await logPre.text()
  check('run log serves the live log from the object before archive',
    logPre.status === 200 && logPreText.includes('run:start') && logPreText.includes('run:end'),
    `${logPre.status} ${logPreText.slice(0, 120)}`)

  // Terminal + no artifact_key → the cron archive backstop flushes it to R2.
  d1Query(persistDir, "UPDATE runs SET status = 'passed', ended_at = 1 WHERE id = 'e2e-artifact-run'")
  const sched = await fetch(`${BASE}/cdn-cgi/handler/scheduled`)
  check('scheduled handler reachable', sched.status === 200, `got ${sched.status}`)
  check('cron archive backstop wrote the artifact_key', await waitFor(() => {
    const r = d1Query(persistDir, "SELECT artifact_key FROM runs WHERE id = 'e2e-artifact-run'")
    return r[0].artifact_key != null
  }), 'artifact_key never set')

  // After archive: getRunLog prefers the R2 artifact.
  const logPost = await fetch(`${BASE}/api/runs/e2e-artifact-run/log`, { headers: { cookie } })
  const logPostText = await logPost.text()
  check('run log serves from R2 after archive',
    logPost.status === 200 && logPostText.includes('run:start') && logPostText.includes('run:end'),
    `${logPost.status} ${logPostText.slice(0, 120)}`)

  // The object keeps its log (no prune), so viewer replay still serves it; the
  // R2 archive is the fallback only once the object is reset at PR teardown.
  const artifactReplay = await collectWs('/api/runs/e2e-artifact-run/ws', cookie, 2500)
  const artTypes = artifactReplay.events.map((e) => e.type)
  check('viewer replay serves the full log after archive',
    artTypes.includes('run:start') && artTypes.includes('run:end'), JSON.stringify(artTypes))
  check('replay has no duplicate seq',
    artifactReplay.seqs.length === new Set(artifactReplay.seqs).size, JSON.stringify(artifactReplay.seqs))
  artBox.close()

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
