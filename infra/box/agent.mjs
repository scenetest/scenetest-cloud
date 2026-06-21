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
// Zero dependencies: node >= 22 builtins only (global WebSocket included).
// Test hooks: SCENETEST_SKIP_CHECKOUT=1 skips clone/setup,
// SCENETEST_NO_POWEROFF=1 logs instead of powering off.

import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, relative } from 'node:path'

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
let currentVector = {} // stage -> input_hash, from the latest pipeline update (#25)
const seqByRun = new Map()
const runEndByRun = new Map() // runId -> run:end payload (settles the verdict)

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
  if (vector && typeof vector === 'object') currentVector = vector
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
      // The stage owns whether it emits reports (#25): static-analysis stages
      // (lint/typecheck/bundle) POST report items to SCENETEST_REPORT_URL, the
      // agent's local /reports ingest, which tags them with the ambient stage
      // and its input hash (currentVector) and relays them upstream.
      execFileSync('bash', ['-c', stage.run], {
        cwd: repoDir ?? WORK_DIR,
        stdio: 'inherit',
        env: {
          ...process.env,
          SCENETEST_STAGE: stage.name,
          SCENETEST_STAGE_HASH: (vector ?? {})[stage.name] ?? '',
          SCENETEST_REPORT_URL: `http://127.0.0.1:${LOCAL_PORT}/reports/${encodeURIComponent(stage.name)}`,
        },
      })
    }
    await fetch(`${INGEST_URL}/api/boxes/${BOX_ID}/ready`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, realized: vector ?? null, head_sha: headSha ?? null }),
    })
    log('update complete; reported ready')
    // Static-analysis reports (#25) run after the box is ready — best-effort, so
    // a report failure never blocks runs. Each ships its raw output up; the
    // worker parses it. Only cache-miss reports are sent (the worker filtered).
    if (Array.isArray(update?.reports)) {
      for (const r of update.reports) await runReport(r, repoDir ?? WORK_DIR)
    }
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

// Relay a stage's report batch upstream (#25). Stage-scoped, not run-scoped:
// keyed by the stage's input hash (the agent owns the vector, so the stage
// can't spoof a hash). The coordinator upserts the overview_* tables. Falls
// back to the env hash if the stage isn't in the latest update's vector.
function relayReport(stage, reports, hashHint) {
  const inputHash = currentVector[stage] ?? hashHint ?? ''
  appendFileSync(join(WORK_DIR, `reports.jsonl`), JSON.stringify({ stage, inputHash, reports }) + '\n')
  if (ws?.readyState === WebSocket.OPEN && inputHash) {
    ws.send(JSON.stringify({ kind: 'report', stage, inputHash, reports }))
    return true
  }
  return false
}

// Ship a report's raw output up the channel (#25). The worker parses it with
// the type's adapter — the box stays format-agnostic. `root` lets the worker
// relativize file paths so an issue's identity is stable across base/head.
function relayReportRaw(name, type, inputHash, raw, root, tool, exitCode) {
  appendFileSync(join(WORK_DIR, `reports.jsonl`), JSON.stringify({ name, type, inputHash, exitCode }) + '\n')
  if (ws?.readyState === WebSocket.OPEN && inputHash) {
    ws.send(JSON.stringify({ kind: 'report-raw', name, type, inputHash, raw, root, tool, exitCode }))
    return true
  }
  return false
}

// Run one report from the update's plan. Builtin `loc` is pure IO (walk +
// count); tool reports run their command and capture stdout. Either way the
// agent only collects raw output and relays it — the worker owns parsing.
function runReport(item, cwd) {
  if (!item || typeof item.name !== 'string' || typeof item.inputHash !== 'string') return
  try {
    if (item.type === 'loc') {
      const raw = JSON.stringify(collectLoc(cwd, item.watch ?? [], item.exclude ?? []))
      relayReportRaw(item.name, 'loc', item.inputHash, raw, cwd, undefined, 0)
      return
    }
    if (typeof item.run !== 'string') return
    let raw = ''
    let exitCode = 0
    try {
      raw = execFileSync('bash', ['-c', item.run], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    } catch (err) {
      // Linters exit non-zero when they find problems — that's not a failure,
      // the findings are on stdout. Capture them and pass the code along.
      raw = err.stdout ? err.stdout.toString() : ''
      exitCode = typeof err.status === 'number' ? err.status : 1
    }
    relayReportRaw(item.name, item.type, item.inputHash, raw, cwd, item.tool, exitCode)
  } catch (err) {
    log(`report ${item.name} failed: ${err.message}`)
  }
}

// Minimal glob match, mirroring the worker's globToRegExp: '**' crosses
// directories, '*' stays in a segment. Kept tiny and dependency-free.
function globToRe(glob) {
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
        if (glob[i + 1] === '/') i++
        if (glob[i] === '/') out += '/?'
      } else out += '[^/]*'
    } else if ('\\^$.|?+()[]{}'.includes(c)) out += '\\' + c
    else out += c
  }
  return new RegExp(out + '$')
}

// Walk `cwd`, count lines of every file matching a `watch` glob and no `exclude`
// glob. Skips the usual heavy dirs so a repo's node_modules never gets counted.
function collectLoc(cwd, watch, exclude) {
  const inc = watch.map(globToRe)
  const exc = exclude.map(globToRe)
  const files = []
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage'])
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') {
        if (skip.has(e.name)) continue
      }
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue
        walk(abs)
        continue
      }
      if (!e.isFile()) continue
      const rel = relative(cwd, abs)
      if (!inc.some((g) => g.test(rel))) continue
      if (exc.some((g) => g.test(rel))) continue
      try {
        const text = readFileSync(abs, 'utf8')
        const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
        files.push({ path: rel, lines })
      } catch { /* unreadable/binary — skip */ }
    }
  }
  walk(cwd)
  return { files }
}

// Local ingest: same body shape as the cloud's POST /api/events/:runId, so
// the scenes CLI on this box reports as if to the dev middleware. Events the
// caller didn't number get box-assigned sequence numbers.
function startLocalIngest() {
  const server = createServer((req, res) => {
    const eventsMatch = /^\/events\/([^/]+)$/.exec(req.url ?? '')
    const reportsMatch = /^\/reports\/([^/]+)$/.exec(req.url ?? '')
    if (req.method !== 'POST' || (!eventsMatch && !reportsMatch)) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        res.writeHead(400).end('bad json')
        return
      }
      // Static-analysis report batch from a build stage (#25): POST /reports/:stage
      // with { reports: ReportItem[] }. The agent tags it with the stage's input
      // hash from the latest update vector and relays it upstream.
      if (reportsMatch) {
        const stage = decodeURIComponent(reportsMatch[1])
        const reports = parsed.reports
        if (!Array.isArray(reports) || reports.length === 0) {
          res.writeHead(400).end('no reports')
          return
        }
        const sent = relayReport(stage, reports, parsed.inputHash)
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, relayed: sent, count: reports.length }))
        return
      }
      const runId = decodeURIComponent(eventsMatch[1])
      const events = parsed.events
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
    // Exit 0 with no run:end: the command reported through the ingest /
    // /complete itself; leave it be.
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
