#!/usr/bin/env node
// The box agent: the droplet-side counterpart of the PR coordinator's box
// channel. Baked into the runner image at /opt/scenetest/agent.mjs and
// started by the scenetest-runner systemd unit after provision user_data
// writes /etc/scenetest/run.env.
//
// Responsibilities (see docs/runner-provisioning.md):
//   1. Clone SCENETEST_REPO at SCENETEST_HEAD_SHA, then hold one outbound
//      WebSocket to SCENETEST_INGEST_URL/api/boxes/:id/channel (reconnect
//      with backoff).
//   2. On {kind:'update'}: checkout the sha, run the pipeline stages, report
//      the realized vector via /ready (failure retires the box). The update
//      also carries the pipeline's scenes command.
//   3. On {kind:'dispatch'}: run the scenes command with the batch's env
//      (incl. SCENETEST_REPORT_URL → the local ingest). The scenes CLI POSTs
//      its event batches there; a run:end event settles the verdict, and a
//      non-zero exit is the failed backstop.
//   4. Relay events: the local HTTP ingest on 127.0.0.1:4999 accepts the
//      scenes CLI's report body (POST /events/:runId, the same
//      {events:[{seq,payload}]} shape as the cloud ingest); envelopes go up
//      the socket and into runs/<runId>.jsonl (debug trail + future R2
//      artifact).
//   5. On {kind:'command'}: append to runs/<runId>.commands.jsonl where the
//      scenes command can consume it. (v0 — a richer hand-off to the CLI
//      comes with the receiver-core integration.)
//   6. Power off when the channel closes with "box retired".
//
// Privilege split (docs/threat-model.md): the agent runs as root and holds
// the bearer token. Every repo-supplied command — git operations on the
// checkout, pipeline stages, the scenes command — runs as SCENETEST_RUN_AS
// with commandEnv()'s allowlisted environment, in a checkout that user owns.
// The agent's own files (run logs, command files) live in WORK_DIR, which
// that user can read but not write.
//
// Zero dependencies: node >= 22 builtins only (global WebSocket included).
// Test hooks: SCENETEST_SKIP_CHECKOUT=1 skips clone/setup,
// SCENETEST_NO_POWEROFF=1 logs instead of powering off.

import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, chownSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------- pure helpers (exported for tests) ---------------------------------

// Run ids name files in WORK_DIR, and the local ingest takes them from a URL
// any repo command can POST to: nothing that can climb out of the directory.
export function isSafeRunId(runId) {
  return typeof runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)
}

const INHERITED_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'DOCKER_HOST']
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

// The complete environment a repo command sees: a few locale/path keys from
// the agent's own environment, the identity of the user it runs as, and the
// caller's extras. Nothing else from agentEnv crosses over — the agent's
// environment carries the bearer token (systemd loads run.env into it).
export function commandEnv(agentEnv, identity, extra = {}) {
  const out = {}
  for (const k of INHERITED_ENV) if (agentEnv[k] !== undefined) out[k] = agentEnv[k]
  out.PATH ??= DEFAULT_PATH
  if (identity) {
    out.HOME = identity.home
    out.USER = identity.name
    out.LOGNAME = identity.name
  } else {
    for (const k of ['HOME', 'USER', 'LOGNAME']) if (agentEnv[k] !== undefined) out[k] = agentEnv[k]
  }
  return { ...out, ...extra }
}

// ---------- configuration ------------------------------------------------------

let BOX_ID, REPO, HEAD_SHA, BASE_SHA, BASE_REF, INGEST_URL, TOKEN, WORK_DIR, LOCAL_PORT, AUTH
// The sha the checkout is at: HEAD_SHA at boot, then each update's headSha.
let currentSha
// { name, uid, gid, home } of SCENETEST_RUN_AS, or null to run repo
// commands as the agent's own user (only allowed when that isn't root).
let runAs = null

function loadConfig() {
  const env = (k, fallback) => {
    const v = process.env[k] ?? fallback
    if (v === undefined) {
      console.error(`agent: missing required env ${k}`)
      process.exit(1)
    }
    return v
  }
  BOX_ID = env('SCENETEST_BOX_ID')
  REPO = env('SCENETEST_REPO')
  HEAD_SHA = env('SCENETEST_HEAD_SHA')
  BASE_SHA = env('SCENETEST_BASE_SHA', '')
  BASE_REF = env('SCENETEST_BASE_REF', '')
  currentSha = HEAD_SHA
  INGEST_URL = env('SCENETEST_INGEST_URL').replace(/\/+$/, '')
  TOKEN = env('SCENETEST_BEARER_TOKEN')
  WORK_DIR = env('SCENETEST_WORK_DIR', '/opt/scenetest/work')
  LOCAL_PORT = Number(env('SCENETEST_LOCAL_PORT', '4999'))
  AUTH = { authorization: `Bearer ${TOKEN}` }

  const name = process.env.SCENETEST_RUN_AS
  if (name) {
    runAs = lookupUser(name)
  } else if (process.getuid?.() === 0) {
    console.error('agent: refusing to run repo commands as root; set SCENETEST_RUN_AS')
    process.exit(1)
  }
}

function lookupUser(name) {
  const line = execFileSync('getent', ['passwd', name], { encoding: 'utf8' }).trim()
  const [, , uid, gid, , home] = line.split(':')
  return { name, uid: Number(uid), gid: Number(gid), home }
}

const log = (...args) => console.log(new Date().toISOString(), ...args)

// ---------- running repo commands ----------------------------------------------

// spawn/execFileSync options that run a child as the repo-command user.
// Setting uid/gid makes libuv call setgroups(0) first, so the child gets no
// supplementary groups: adding that user to a group (docker, sudo, ...) has
// no effect on repo commands.
function asRunUser(extraEnv = {}) {
  return {
    env: commandEnv(process.env, runAs, { ...boxEnv(), ...extraEnv }),
    ...(runAs ? { uid: runAs.uid, gid: runAs.gid } : {}),
  }
}

// What a repo command may know about the box and the commit. Not secret.
function boxEnv() {
  return {
    SCENETEST_BOX_ID: BOX_ID,
    SCENETEST_REPO: REPO,
    SCENETEST_HEAD_SHA: currentSha,
    SCENETEST_BASE_SHA: BASE_SHA,
    SCENETEST_BASE_REF: BASE_REF,
  }
}

function runRepoSync(file, args, opts = {}) {
  return execFileSync(file, args, { stdio: ['ignore', 'inherit', 'inherit'], ...asRunUser(), ...opts })
}

// The cloud metadata endpoint serves this droplet's user_data, which carries
// the bearer token in plaintext. Reject the repo-command user's traffic to
// all of link-local before any repo command runs; if the rule can't be
// installed, the agent exits rather than run commands without it.
function blockMetadata() {
  const rule = ['OUTPUT', '-d', '169.254.0.0/16', '-m', 'owner', '--uid-owner', String(runAs.uid), '-j', 'REJECT']
  try {
    execFileSync('iptables', ['-w', '-C', ...rule], { stdio: 'ignore' })
  } catch {
    execFileSync('iptables', ['-w', '-I', ...rule])
  }
  log(`blocked link-local (metadata) for uid ${runAs.uid}`)
}

let ws = null
let currentScenes = null // from the latest pipeline update
const seqByRun = new Map()
const runEndByRun = new Map() // runId -> run:end payload (settles the verdict)

// ---------- checkout + project setup -----------------------------------------

// The checkout directory, owned by the repo-command user. Created empty in
// test mode (SCENETEST_SKIP_CHECKOUT=1) so commands still get a cwd of their own.
function prepareRepoDir() {
  const dir = join(WORK_DIR, 'repo')
  const fresh = !existsSync(dir)
  if (fresh) {
    mkdirSync(dir)
    if (runAs) chownSync(dir, runAs.uid, runAs.gid)
  }
  if (fresh && process.env.SCENETEST_SKIP_CHECKOUT !== '1') {
    log(`cloning ${REPO} @ ${HEAD_SHA}`)
    // Public repos only for now (docs/runner-provisioning.md tracks the
    // credential question). Fetch the single sha, shallow. Project setup
    // arrives as pipeline stages in an 'update' message (the default
    // pipeline's stage runs scenetest/box-setup.sh, so hook-era repos behave
    // the same).
    runRepoSync('git', ['init', '-q', dir])
    runRepoSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`])
    checkoutSha(dir, HEAD_SHA)
  }
  return dir
}

// Move the checkout to a new sha (warm-box pipeline update). Runs as the
// repo-command user like everything else touching the checkout: earlier
// stages could have written .git/config (core.fsmonitor, hooks), and git
// executes what it finds there.
function checkoutSha(repoDir, sha) {
  runRepoSync('git', ['-C', repoDir, 'fetch', '-q', '--depth', '1', 'origin', sha])
  runRepoSync('git', ['-C', repoDir, 'checkout', '-q', 'FETCH_HEAD'])
}

// ---------- pipeline updates --------------------------------------------------

// { kind: 'update', update: { headSha, vector, stages: [{name, run}] } }:
// checkout the sha, run the stages in order, and report the realized vector
// back through /api/boxes/:id/ready. The vector is computed worker-side; the
// agent just echoes it after the work succeeds. A failed stage reports
// ok:false — the worker retires this box and the next push starts fresh.
async function applyUpdate(update, repoDir) {
  const { headSha, vector, stages, scenes } = update ?? {}
  if (typeof scenes === 'string') currentScenes = scenes
  if (!Array.isArray(stages)) return
  log(`update: ${stages.length} stage(s) at ${headSha}`)
  let current = 'checkout'
  try {
    if (headSha && process.env.SCENETEST_SKIP_CHECKOUT !== '1') {
      checkoutSha(repoDir, headSha)
    }
    if (headSha) currentSha = headSha
    for (const stage of stages) {
      current = stage.name
      if (!stage.run) continue
      log(`stage ${stage.name}: ${stage.run}`)
      runRepoSync('bash', ['-c', stage.run], { cwd: repoDir })
    }
    await fetch(`${INGEST_URL}/api/boxes/${BOX_ID}/ready`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, realized: vector ?? null, head_sha: headSha ?? null }),
    })
    log('update complete; reported ready')
  } catch (err) {
    log(`update failed at stage '${current}': ${err.message}`)
    await fetch(`${INGEST_URL}/api/boxes/${BOX_ID}/ready`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ok: false, failed_stage: current }),
    }).catch(() => {})
  }
}

// ---------- event relay -------------------------------------------------------

// Assign sequence numbers (preserving any the caller provided), note any
// run:end (it settles the batch's verdict), and relay. The only event entry
// point now — the scenes CLI POSTs its batches here via --report-url.
function ingestEvents(runId, rawEvents) {
  let seq = seqByRun.get(runId) ?? 0
  const numbered = rawEvents.map((e) =>
    typeof e.seq === 'number' ? ((seq = Math.max(seq, e.seq)), e) : { seq: ++seq, payload: e.payload ?? e },
  )
  seqByRun.set(runId, seq)
  for (const e of numbered) {
    const p = e.payload ?? e
    if (p && p.type === 'run:end') runEndByRun.set(runId, p)
  }
  return relayEvents(runId, numbered)
}

function relayEvents(runId, events) {
  for (const e of events) {
    appendFileSync(join(WORK_DIR, `${runId}.jsonl`), JSON.stringify(e.payload ?? e) + '\n')
  }
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ kind: 'events', runId, events }))
    return true
  }
  return false
}

// Local ingest: same body shape as the cloud's POST /api/events/:runId, so
// the scenes CLI on this box reports as if to the dev middleware. Events the
// caller didn't number get box-assigned sequence numbers.
function startLocalIngest() {
  const server = createServer((req, res) => {
    const m = /^\/events\/([^/]+)$/.exec(req.url ?? '')
    if (req.method !== 'POST' || !m) {
      res.writeHead(404).end()
      return
    }
    let runId
    try {
      runId = decodeURIComponent(m[1])
    } catch {
      runId = null
    }
    if (!isSafeRunId(runId)) {
      res.writeHead(400).end('bad run id')
      return
    }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let events
      try {
        events = JSON.parse(body).events
      } catch {
        res.writeHead(400).end('bad json')
        return
      }
      if (!Array.isArray(events) || events.length === 0) {
        res.writeHead(400).end('no events')
        return
      }
      const sent = ingestEvents(runId, events)
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, relayed: sent, count: events.length }))
    })
  })
  server.listen(LOCAL_PORT, '127.0.0.1', () => log(`local ingest on 127.0.0.1:${LOCAL_PORT}`))
}

// ---------- batch execution ---------------------------------------------------

async function completeRun(runId, status) {
  await fetch(`${INGEST_URL}/api/runs/${runId}/complete`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  }).catch((err) => log(`complete(${runId}) failed:`, err.message))
}

// The scenes command comes from the pipeline file via the latest update
// (default: the legacy box-run.sh hook). The scenes CLI streams its events
// to SCENETEST_REPORT_URL (@scenetest/scenes >=0.15 --report-url), which
// points at this agent's local ingest; a run:end event settles the
// verdict, so the command never has to call /complete itself.
function runBatch(run, repoDir) {
  const command = currentScenes ?? 'bash scenetest/box-run.sh'
  log(`running batch ${run.runId} (subset: ${run.subset ? run.subset.length : 'all'}): ${command}`)
  const localIngest = `http://127.0.0.1:${LOCAL_PORT}`

  const child = spawn('bash', ['-c', command], {
    cwd: repoDir,
    stdio: ['ignore', 'inherit', 'inherit'],
    ...asRunUser({
      SCENETEST_RUN_ID: run.runId,
      // Carries dispatch intent (run all / a subset of scene ids). The CLI
      // has no --subset flag; a scenes command that wants subsetting expands
      // this to positional scene paths itself.
      SCENETEST_SUBSET: run.subset ? JSON.stringify(run.subset) : '',
      SCENETEST_LOCAL_INGEST: localIngest,
      // Where the scenes CLI POSTs its event batches; the box wires it so a
      // bare `scenetest` reports to the dashboard.
      SCENETEST_REPORT_URL: `${localIngest}/events/${run.runId}`,
    }),
  })

  child.on('exit', (code) => {
    log(`batch ${run.runId} exited ${code}`)
    const end = runEndByRun.get(run.runId)
    runEndByRun.delete(run.runId)
    if (code !== 0) {
      // Backstop: no batch is left dangling.
      void completeRun(run.runId, 'failed')
    } else if (end) {
      // The verdict comes from the run's own summary when it reported one.
      const failed = end.summary?.failed ?? 0
      void completeRun(run.runId, failed > 0 ? 'failed' : 'passed')
    }
    // Exit 0 with no run:end seen here: leave it be. The command holds no
    // token, so it can't call /complete itself.
  })
  // Without a listener, a failed spawn (e.g. a bad SCENETEST_RUN_AS uid) is
  // an uncaught error that takes the whole agent down.
  child.on('error', (err) => {
    log(`batch ${run.runId} failed to start: ${err.message}`)
    runEndByRun.delete(run.runId)
    void completeRun(run.runId, 'failed')
  })
}

// ---------- the channel -------------------------------------------------------

function connectChannel(repoDir, attempt = 0) {
  const url = `${INGEST_URL.replace(/^http/, 'ws')}/api/boxes/${BOX_ID}/channel?token=${encodeURIComponent(TOKEN)}`
  ws = new WebSocket(url)

  ws.addEventListener('open', () => {
    attempt = 0
    log('channel connected')
  })

  ws.addEventListener('message', (e) => {
    let msg
    try {
      msg = JSON.parse(e.data)
    } catch {
      return
    }
    if (msg.kind === 'dispatch' && isSafeRunId(msg.run?.runId)) runBatch(msg.run, repoDir)
    else if (msg.kind === 'update') void applyUpdate(msg.update, repoDir)
    else if (msg.kind === 'command' && isSafeRunId(msg.runId)) {
      appendFileSync(
        join(WORK_DIR, `${msg.runId}.commands.jsonl`),
        JSON.stringify(msg.command) + '\n',
      )
      log(`command for ${msg.runId}: ${msg.command?.type}`)
    } else if (msg.kind === 'error') log('channel error message:', msg.message)
  })

  ws.addEventListener('close', (e) => {
    if (e.reason === 'box retired') {
      log('box retired; shutting down')
      if (process.env.SCENETEST_NO_POWEROFF === '1') process.exit(0)
      execFileSync('systemctl', ['poweroff'])
      return
    }
    const delayMs = Math.min(1000 * 2 ** attempt, 30_000)
    log(`channel closed (${e.code} ${e.reason || 'no reason'}); reconnecting in ${delayMs}ms`)
    setTimeout(() => connectChannel(repoDir, attempt + 1), delayMs)
  })

  ws.addEventListener('error', () => {
    // close fires after error; reconnect is handled there.
  })
}

// ---------- main --------------------------------------------------------------

function main() {
  loadConfig()
  if (runAs && process.env.SCENETEST_BLOCK_METADATA === '1') blockMetadata()
  mkdirSync(WORK_DIR, { recursive: true })
  const repoDir = prepareRepoDir()
  startLocalIngest()

  // No bare "ready" on boot: readiness is the outcome of the queued pipeline
  // update, which arrives the moment the channel connects (FIFO, ahead of any
  // dispatches) and reports through /ready with the realized stage vector.
  connectChannel(repoDir)
}

// Imported by unit tests for the helpers above; only `node agent.mjs` boots.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main()
