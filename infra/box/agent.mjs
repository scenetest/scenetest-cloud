#!/usr/bin/env node
// The box agent: the droplet-side counterpart of the PR coordinator's box
// channel. Baked into the runner image at /opt/scenetest/agent.mjs and
// started by the scenetest-runner systemd unit after provision user_data
// writes /etc/scenetest/run.env.
//
// Responsibilities (see docs/runner-provisioning.md):
//   1. Clone SCENETEST_REPO at SCENETEST_HEAD_SHA and run the project's
//      box setup (scenetest/box-setup.sh — app + db + seeds, backgrounded).
//   2. Report the box ready, then hold one outbound WebSocket to
//      SCENETEST_INGEST_URL/api/boxes/:id/channel (reconnect with backoff).
//   3. On {kind:'dispatch'}: run the project's scenetest/box-run.sh with the
//      batch's env; mark the run failed if the script is missing or exits
//      non-zero, since a batch that can't run still needs a verdict.
//   4. Relay events: a local HTTP ingest on 127.0.0.1:4999 accepts the same
//      body as the cloud ingest (POST /events/:runId) so the scenes CLI on
//      the box reports same-origin-style; envelopes go up the socket and
//      into runs/<runId>.jsonl on disk (debug trail + future R2 artifact).
//   5. On {kind:'command'}: append to runs/<runId>.commands.jsonl where the
//      run script can consume it. (v0 — a richer hand-off to the CLI comes
//      with the receiver-core integration.)
//   6. Power off when the channel closes with "box retired".
//
// Zero dependencies: node >= 22 builtins only (global WebSocket included).
// Test hooks: SCENETEST_SKIP_CHECKOUT=1 skips clone/setup,
// SCENETEST_NO_POWEROFF=1 logs instead of powering off.

import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const env = (k, fallback) => {
  const v = process.env[k] ?? fallback
  if (v === undefined) {
    console.error(`agent: missing required env ${k}`)
    process.exit(1)
  }
  return v
}

const BOX_ID = env('SCENETEST_BOX_ID')
const REPO = env('SCENETEST_REPO')
const HEAD_SHA = env('SCENETEST_HEAD_SHA')
const INGEST_URL = env('SCENETEST_INGEST_URL').replace(/\/+$/, '')
const TOKEN = env('SCENETEST_BEARER_TOKEN')
const WORK_DIR = env('SCENETEST_WORK_DIR', '/opt/scenetest/work')
const LOCAL_PORT = Number(env('SCENETEST_LOCAL_PORT', '4999'))

const AUTH = { authorization: `Bearer ${TOKEN}` }
const log = (...args) => console.log(new Date().toISOString(), ...args)

let ws = null
const seqByRun = new Map()

// ---------- checkout + project setup -----------------------------------------

function checkout() {
  const dir = join(WORK_DIR, 'repo')
  if (existsSync(dir)) return dir
  mkdirSync(WORK_DIR, { recursive: true })
  log(`cloning ${REPO} @ ${HEAD_SHA}`)
  // Public repos only for now (docs/runner-provisioning.md tracks the
  // credential question). Fetch the single sha, shallow. Project setup is no
  // longer run here: it arrives as pipeline stages in an 'update' message
  // (the default pipeline's stage runs scenetest/box-setup.sh, so hook-era
  // repos behave the same).
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`])
  execFileSync('git', ['-C', dir, 'fetch', '-q', '--depth', '1', 'origin', HEAD_SHA])
  execFileSync('git', ['-C', dir, 'checkout', '-q', 'FETCH_HEAD'])
  return dir
}

// Move the checkout to a new sha (warm-box pipeline update).
function checkoutSha(repoDir, sha) {
  execFileSync('git', ['-C', repoDir, 'fetch', '-q', '--depth', '1', 'origin', sha])
  execFileSync('git', ['-C', repoDir, 'checkout', '-q', 'FETCH_HEAD'])
}

// ---------- pipeline updates --------------------------------------------------

// { kind: 'update', update: { headSha, vector, stages: [{name, run}] } }:
// checkout the sha, run the stages in order, and report the realized vector
// back through /api/boxes/:id/ready. The vector is computed worker-side; the
// agent just echoes it after the work succeeds. A failed stage reports
// ok:false — the worker retires this box and the next push starts fresh.
async function applyUpdate(update, repoDir) {
  const { headSha, vector, stages } = update ?? {}
  if (!Array.isArray(stages)) return
  log(`update: ${stages.length} stage(s) at ${headSha}`)
  let current = 'checkout'
  try {
    if (repoDir && headSha && process.env.SCENETEST_SKIP_CHECKOUT !== '1') {
      checkoutSha(repoDir, headSha)
    }
    for (const stage of stages) {
      current = stage.name
      if (!stage.run) continue
      log(`stage ${stage.name}: ${stage.run}`)
      execFileSync('bash', ['-c', stage.run], { cwd: repoDir ?? WORK_DIR, stdio: 'inherit' })
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
    const runId = decodeURIComponent(m[1])
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
      let seq = seqByRun.get(runId) ?? 0
      const numbered = events.map((e) =>
        typeof e.seq === 'number' ? ((seq = Math.max(seq, e.seq)), e) : { seq: ++seq, payload: e.payload ?? e },
      )
      seqByRun.set(runId, seq)
      const sent = relayEvents(runId, numbered)
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, relayed: sent, count: numbered.length }))
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

function runBatch(run, repoDir) {
  const script = repoDir && join(repoDir, 'scenetest', 'box-run.sh')
  if (!script || !existsSync(script)) {
    log(`dispatch for ${run.runId}: no scenetest/box-run.sh — failing the run`)
    void completeRun(run.runId, 'failed')
    return
  }
  log(`running batch ${run.runId} (subset: ${run.subset ? run.subset.length : 'all'})`)
  const child = spawn('bash', [script], {
    cwd: repoDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      SCENETEST_RUN_ID: run.runId,
      SCENETEST_SUBSET: run.subset ? JSON.stringify(run.subset) : '',
      SCENETEST_LOCAL_INGEST: `http://127.0.0.1:${LOCAL_PORT}`,
    },
  })
  child.on('exit', (code) => {
    log(`batch ${run.runId} exited ${code}`)
    // The run script is expected to report its own verdict via the scenes
    // CLI; a non-zero exit is the backstop so no run is left dangling.
    if (code !== 0) void completeRun(run.runId, 'failed')
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
    if (msg.kind === 'dispatch' && msg.run?.runId) runBatch(msg.run, repoDir)
    else if (msg.kind === 'update') void applyUpdate(msg.update, repoDir)
    else if (msg.kind === 'command' && msg.runId) {
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

mkdirSync(WORK_DIR, { recursive: true })
const repoDir = process.env.SCENETEST_SKIP_CHECKOUT === '1' ? null : checkout()
startLocalIngest()

// No bare "ready" on boot: readiness is the outcome of the queued pipeline
// update, which arrives the moment the channel connects (FIFO, ahead of any
// dispatches) and reports through /ready with the realized stage vector.
connectChannel(repoDir)
