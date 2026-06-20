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
//   5. On {kind:'command'}: run:stop kills the in-flight batch's process group
//      (the exit handler settles the run 'cancelled'); any other command is
//      appended to runs/<runId>.commands.jsonl as the escape hatch a custom
//      scenes command can tail (pause/resume live there until the CLI honors
//      them mid-run). Commands are PR-scoped — runId is optional bookkeeping,
//      not the address. run:replay never arrives here: it is worker-side run
//      creation (a new batch), not a box poke.
//   6. Power off when the channel closes with "box retired".
//
// Zero dependencies: node >= 22 builtins only (global WebSocket included).
// Test hooks: SCENETEST_SKIP_CHECKOUT=1 skips clone/setup,
// SCENETEST_NO_POWEROFF=1 logs instead of powering off.

import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
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
let currentScenes = null // from the latest pipeline update
const seqByRun = new Map()
const runEndByRun = new Map() // runId -> run:end payload (settles the verdict)
const childByRun = new Map() // runId -> the batch's child process (for run:stop)
const stoppedRuns = new Set() // runIds run:stop killed → verdict is 'cancelled'

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
  const { headSha, vector, stages, scenes } = update ?? {}
  if (typeof scenes === 'string') currentScenes = scenes
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
    cwd: repoDir ?? WORK_DIR,
    stdio: 'inherit',
    // Own process group, so run:stop can SIGTERM the whole tree (bash → scenes
    // CLI → Playwright → browser) by signalling the group, not just bash.
    detached: true,
    env: {
      ...process.env,
      SCENETEST_RUN_ID: run.runId,
      // Carries dispatch intent (run all / a subset of scene ids). The CLI
      // has no --subset flag; a scenes command that wants subsetting expands
      // this to positional scene paths itself.
      SCENETEST_SUBSET: run.subset ? JSON.stringify(run.subset) : '',
      SCENETEST_LOCAL_INGEST: localIngest,
      // Where the scenes CLI POSTs its event batches; the box wires it so a
      // bare `scenetest` reports to the dashboard.
      SCENETEST_REPORT_URL: `${localIngest}/events/${run.runId}`,
    },
  })
  childByRun.set(run.runId, child)

  child.on('exit', (code) => {
    childByRun.delete(run.runId)
    const stopped = stoppedRuns.delete(run.runId)
    const end = runEndByRun.get(run.runId)
    runEndByRun.delete(run.runId)
    log(`batch ${run.runId} exited ${code}${stopped ? ' (stopped)' : ''}`)
    if (stopped) {
      // run:stop killed it: the verdict is the human's cancellation, not the
      // non-zero exit the kill produced. One completion path (here) so the
      // /complete call always lands after the process is truly dead.
      void completeRun(run.runId, 'cancelled')
    } else if (code !== 0) {
      // Backstop: no batch is left dangling.
      void completeRun(run.runId, 'failed')
    } else if (end) {
      // The verdict comes from the run's own summary when it reported one.
      const failed = end.summary?.failed ?? 0
      void completeRun(run.runId, failed > 0 ? 'failed' : 'passed')
    }
    // Exit 0 with no run:end: the command reported through the ingest /
    // /complete itself; leave it be.
  })
}

// run:stop — kill the in-flight batch's process group; the exit handler above
// settles the run as 'cancelled'. Commands are PR-scoped (the PR is the address,
// not the run — see docs/architecture.md), and a box runs one batch at a time,
// so with no runId we stop the sole active batch. A run:stop that finds nothing
// running posts 'cancelled' best-effort; /complete's `ended_at IS NULL` guard
// makes that a no-op if the run already reached a verdict.
function stopRun(runId) {
  const targetId = runId ?? (childByRun.size === 1 ? [...childByRun.keys()][0] : null)
  const child = targetId ? childByRun.get(targetId) : null
  if (!child) {
    log(`run:stop: no active batch${runId ? ` for ${runId}` : ''}`)
    if (targetId) void completeRun(targetId, 'cancelled')
    return
  }
  stoppedRuns.add(targetId)
  log(`run:stop: killing batch ${targetId} (pgid ${child.pid})`)
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (err) {
    log(`run:stop kill failed: ${err.message}`)
  }
  // Escalate if the group ignores SIGTERM. Unref'd so it never holds the agent
  // open; cleared implicitly once the child exits and clears childByRun.
  setTimeout(() => {
    if (childByRun.has(targetId)) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }, 5000).unref()
}

// A command arrived down the channel. run:stop acts on the box here; every other
// command is appended to the run's commands file — the escape hatch a custom
// scenes command can tail (pause/resume map onto it until the CLI honors them
// mid-run). Run-agnostic commands with no box-side handler are just logged.
function handleCommand(command, runId) {
  if (!command || typeof command.type !== 'string') return
  if (command.type === 'run:stop') {
    stopRun(runId)
    return
  }
  if (runId) {
    appendFileSync(join(WORK_DIR, `${runId}.commands.jsonl`), JSON.stringify(command) + '\n')
    log(`command for ${runId}: ${command.type}`)
  } else {
    log(`command (no run): ${command.type} — no box-side handler, ignored`)
  }
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
    else if (msg.kind === 'command' && msg.command) handleCommand(msg.command, msg.runId)
    else if (msg.kind === 'error') log('channel error message:', msg.message)
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
