import type { Env } from '../env.ts'
import { ghHeaders } from '../github.ts'
import { sha256Hex } from '../hash.ts'
import { imageStageHash } from './image.ts'

// The pipeline file: scenetest/pipeline.json in the user's repo. v0 fields
// are `watch` and `run`; `save`, `restore`, and `toolchain` are reserved for
// later versions and validated-but-ignored so files written today survive
// upgrades. Spec and user instructions in docs/pipeline.md.
//
// Semantics (architecture.md, "The build pipeline"): a linear chain of
// stages, each keyed by hash(parent hash, watched tree hashes, stage config,
// pipeline file). A stage re-runs only when its hash changes; a changed
// stage re-runs everything after it. The root parent is the runner image's
// own hash, so a toolchain change rebuilds everything.
//
// Hashes are computed here, in the worker, at webhook time, from the GitHub
// trees API — no checkout. Every failure path degrades to COARSE: a single
// pseudo-stage keyed by the commit sha, which reproduces the old
// rebuild-everything-on-any-change behavior. Degradation can over-rebuild
// but never under-rebuilds.

export interface PipelineStage {
  name: string
  watch: string[]
  run?: string
}

export interface PipelineConfig {
  version: 1
  stages: PipelineStage[]
  // Static-analysis reports (#25): each is a content-addressed stage output —
  // LOC, lint findings, … — keyed by the hash of its declared inputs, so
  // identical inputs share one report across runs and PRs. The box runs/collects
  // them, the worker parses (report-adapters.ts), the overview_* tables store
  // them. Optional and additive: a malformed entry is dropped, not fatal.
  reports: ReportSpec[]
  // How one batch of scenes executes. NOT a stage: stages are
  // content-addressed and skipped when nothing changed; the scenes command
  // is dispatch-triggered and parameterized per run. It still rides the
  // pipeline file, so editing it cascades (the file hashes into every
  // stage) and the box always holds the current command.
  scenes: string
}

// A report's declared inputs and how to produce it. `watch` globs are the
// content inputs (their tree hashes go into the report's key); `after` names
// the build stage whose hash to fold in as a parent, so a toolchain change
// (e.g. a new linter version in the lockfile) invalidates the report too.
// `type` selects the worker-side adapter that parses the box's output.
export interface ReportSpec {
  name: string
  type: 'loc' | 'lint' | 'typecheck' | 'bundle'
  watch: string[]
  // LOC: paths matched by `watch` but also matching `exclude` are not counted
  // (they still hash into the key, so adding an exclude busts the report).
  exclude?: string[]
  // Tool reports (lint): the command the box runs; its stdout is machine-
  // readable output the worker adapter parses. Ignored for builtin types (loc).
  run?: string
  // Adapter sub-format hint, e.g. lint tool 'eslint'. Defaults per type.
  tool?: string
  // Build stage this report depends on (toolchain parent). Absent → root only.
  after?: string
  // Bundle: the built output dir to measure (default 'dist').
  dist?: string
}

// A report resolved to its input hash, as sent to the box for execution.
export interface ReportPlanItem {
  name: string
  type: 'loc' | 'lint' | 'typecheck' | 'bundle'
  inputHash: string
  watch: string[]
  exclude?: string[]
  run?: string
  tool?: string
  dist?: string
}

export interface StagePlan {
  // Stage name → input hash, in stage order. Coarse plans have one
  // pseudo-stage '*coarse*' keyed by the commit sha.
  vector: Record<string, string>
  // What the box must execute on divergence, in order.
  stages: Array<{ name: string; run?: string }>
  // Report name → input hash (the "report vector"), and the full specs the box
  // runs. Empty on the coarse-fallback path.
  reports: Record<string, string>
  reportItems: ReportPlanItem[]
  scenes: string
  coarse: boolean
}

export const PIPELINE_PATH = 'scenetest/pipeline.json'
// Legacy hook fallback, also the default when the file omits `scenes`.
export const DEFAULT_SCENES_COMMAND = 'bash scenetest/box-run.sh'

// Absent or unreadable pipeline file: one stage watching everything, running
// the legacy setup hook if the repo has one. Exactly yesterday's behavior.
export function defaultPipeline(): PipelineConfig {
  return {
    version: 1,
    stages: [
      {
        // Reserved name: '*' can't appear in user stage names (parsePipeline
        // rejects it), so system pseudo-stages are unambiguous downstream
        // (e.g. repoStatus telling "real pipeline" from "coarse default").
        name: '*setup*',
        watch: ['**'],
        run: 'if [ -f scenetest/box-setup.sh ]; then bash scenetest/box-setup.sh; fi',
      },
    ],
    reports: [],
    scenes: DEFAULT_SCENES_COMMAND,
  }
}

// Strict on what we act on, silent on what we reserve. Returns null (caller
// falls back to default) rather than throwing: a malformed pipeline file
// must never block a run, only un-optimize it.
export function parsePipeline(raw: string): PipelineConfig | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  const cfg = data as { version?: unknown; stages?: unknown; scenes?: unknown; reports?: unknown }
  if (cfg.version !== 1 || !Array.isArray(cfg.stages) || cfg.stages.length === 0) return null
  if (cfg.scenes !== undefined && typeof cfg.scenes !== 'string') return null
  if (cfg.reports !== undefined && !Array.isArray(cfg.reports)) return null

  const seen = new Set<string>()
  const stages: PipelineStage[] = []
  for (const s of cfg.stages as Array<Record<string, unknown>>) {
    if (typeof s?.name !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(s.name)) return null
    if (seen.has(s.name)) return null
    seen.add(s.name)
    if (s.run !== undefined && typeof s.run !== 'string') return null
    const watch = s.watch === undefined ? ['**'] : s.watch
    if (!Array.isArray(watch) || !watch.every((g) => typeof g === 'string' && g.length > 0)) return null
    stages.push({ name: s.name, watch: watch as string[], ...(s.run !== undefined ? { run: s.run as string } : {}) })
  }
  return {
    version: 1,
    stages,
    reports: parseReports(cfg.reports),
    scenes: typeof cfg.scenes === 'string' ? cfg.scenes : DEFAULT_SCENES_COMMAND,
  }
}

const REPORT_TYPES = new Set(['loc', 'lint', 'typecheck', 'bundle'])

// Reports are additive outputs, not pipeline structure: a malformed entry is
// dropped (and ignored), never fatal — one typo'd report must not disable the
// stage cache. Returns the valid subset (possibly empty).
export function parseReports(raw: unknown): ReportSpec[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: ReportSpec[] = []
  for (const r of raw as Array<Record<string, unknown>>) {
    if (typeof r?.name !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(r.name) || seen.has(r.name)) continue
    if (!REPORT_TYPES.has(r.type as string)) continue
    if (!Array.isArray(r.watch) || r.watch.length === 0 || !r.watch.every((g) => typeof g === 'string' && g.length > 0)) continue
    if (r.exclude !== undefined && (!Array.isArray(r.exclude) || !r.exclude.every((g) => typeof g === 'string'))) continue
    if (r.run !== undefined && typeof r.run !== 'string') continue
    if (r.tool !== undefined && typeof r.tool !== 'string') continue
    if (r.after !== undefined && typeof r.after !== 'string') continue
    if (r.dist !== undefined && typeof r.dist !== 'string') continue
    // Tool reports need a command to run; builtin loc/bundle must not carry one.
    if ((r.type === 'lint' || r.type === 'typecheck') && typeof r.run !== 'string') continue
    seen.add(r.name)
    out.push({
      name: r.name,
      type: r.type as ReportSpec['type'],
      watch: r.watch as string[],
      ...(r.exclude !== undefined ? { exclude: r.exclude as string[] } : {}),
      ...(r.run !== undefined ? { run: r.run as string } : {}),
      ...(r.tool !== undefined ? { tool: r.tool as string } : {}),
      ...(r.after !== undefined ? { after: r.after as string } : {}),
      ...(r.dist !== undefined ? { dist: r.dist as string } : {}),
    })
  }
  return out
}

// Minimal glob-to-regex: '**' crosses directories, '*' stays within one path
// segment, everything else is literal. No negation, no braces — documented
// in docs/pipeline.md. Coarse globs are safe; clever ones aren't needed.
export function globToRegExp(glob: string): RegExp {
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
        // swallow a '/' directly after '**' so 'dir/**' also matches 'dir/x'
        if (glob[i + 1] === '/') i++
        if (glob[i] === '/') out += '/?'
      } else {
        out += '[^/]*'
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      out += '\\' + c
    } else {
      out += c
    }
  }
  return new RegExp(out + '$')
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path))
}

export interface TreeEntry {
  path: string
  sha: string
}

// Pure: vector from a tree listing + config. Exposed for tests; the network
// wrapper below feeds it.
export async function computeVector(
  config: PipelineConfig,
  tree: TreeEntry[],
  rootHash: string,
  pipelineFileSha: string,
): Promise<{ vector: Record<string, string>; stages: Array<{ name: string; run?: string }> }> {
  const vector: Record<string, string> = {}
  let prev = rootHash
  for (const stage of config.stages) {
    // Compile each stage's globs once, not once per tree entry — large
    // repos have tens of thousands of blobs.
    const globs = stage.watch.map(globToRegExp)
    const matched = tree
      .filter((e) => globs.some((g) => g.test(e.path)))
      .map((e) => `${e.path}:${e.sha}`)
      .sort()
    const input = [JSON.stringify({ name: stage.name, run: stage.run ?? null, watch: stage.watch }), prev, pipelineFileSha, ...matched].join('\n')
    const hash = (await sha256Hex(input)).slice(0, 16)
    vector[stage.name] = hash
    prev = hash
  }
  return {
    vector,
    stages: config.stages.map((s) => ({ name: s.name, ...(s.run !== undefined ? { run: s.run } : {}) })),
  }
}

// Resolve each configured report to its input hash (#25). A report's key is
// hash(report config, parent stage hash, pipeline file, watched tree hashes):
// the watched globs give content invalidation, and `after` folds in the build
// stage's hash so a toolchain change busts the report. Pure; computeStagePlan
// feeds it the vector computeVector just produced. Returns the report vector
// (name → hash) and the full specs the box runs.
export async function computeReportPlan(
  reports: ReportSpec[],
  tree: TreeEntry[],
  vector: Record<string, string>,
  rootHash: string,
  pipelineFileSha: string,
): Promise<{ reports: Record<string, string>; items: ReportPlanItem[] }> {
  const out: Record<string, string> = {}
  const items: ReportPlanItem[] = []
  for (const r of reports) {
    const globs = r.watch.map(globToRegExp)
    const matched = tree
      .filter((e) => globs.some((g) => g.test(e.path)))
      .map((e) => `${e.path}:${e.sha}`)
      .sort()
    const parent = r.after && vector[r.after] ? vector[r.after] : rootHash
    const config = JSON.stringify({
      name: r.name,
      type: r.type,
      watch: r.watch,
      exclude: r.exclude ?? null,
      run: r.run ?? null,
      tool: r.tool ?? null,
      after: r.after ?? null,
      dist: r.dist ?? null,
    })
    const hash = (await sha256Hex([config, parent, pipelineFileSha, ...matched].join('\n'))).slice(0, 16)
    out[r.name] = hash
    items.push({
      name: r.name,
      type: r.type,
      inputHash: hash,
      watch: r.watch,
      ...(r.exclude !== undefined ? { exclude: r.exclude } : {}),
      ...(r.run !== undefined ? { run: r.run } : {}),
      ...(r.tool !== undefined ? { tool: r.tool } : {}),
      ...(r.dist !== undefined ? { dist: r.dist } : {}),
    })
  }
  return { reports: out, items }
}

function coarsePlan(headSha: string): StagePlan {
  const fallback = defaultPipeline()
  return {
    vector: { '*coarse*': headSha },
    stages: fallback.stages.map((s) => ({ name: s.name, run: s.run })),
    reports: {},
    reportItems: [],
    scenes: fallback.scenes,
    coarse: true,
  }
}

// The webhook-time entry point: pipeline file + recursive tree → stage plan.
// Unauthenticated GitHub API calls are rate-limited from worker egress IPs
// (set GITHUB_API_TOKEN to lift that); any failure, truncation, or parse
// problem degrades to the coarse plan.
export async function computeStagePlan(env: Env, repo: string, headSha: string): Promise<StagePlan> {
  try {
    const treeResp = await fetch(
      `https://api.github.com/repos/${repo}/git/trees/${headSha}?recursive=1`,
      { headers: ghHeaders(env) },
    )
    if (!treeResp.ok) throw new Error(`trees API ${treeResp.status}`)
    const treeData = (await treeResp.json()) as {
      truncated: boolean
      tree: Array<{ path: string; sha: string; type: string }>
    }
    if (treeData.truncated) throw new Error('tree truncated')
    const tree: TreeEntry[] = treeData.tree
      .filter((e) => e.type === 'blob')
      .map((e) => ({ path: e.path, sha: e.sha }))

    const pipelineEntry = treeData.tree.find((e) => e.path === PIPELINE_PATH && e.type === 'blob')
    let config = defaultPipeline()
    let pipelineFileSha = 'default'
    if (pipelineEntry) {
      const blobResp = await fetch(
        `https://api.github.com/repos/${repo}/git/blobs/${pipelineEntry.sha}`,
        { headers: ghHeaders(env) },
      )
      if (!blobResp.ok) throw new Error(`blobs API ${blobResp.status}`)
      const blob = (await blobResp.json()) as { content: string }
      const parsed = parsePipeline(atob(blob.content.replaceAll('\n', '')))
      if (parsed) {
        config = parsed
        pipelineFileSha = pipelineEntry.sha
      } else {
        console.warn(`pipeline: ${repo}@${headSha} has invalid ${PIPELINE_PATH}; using default`)
      }
    }

    const rootHash = await imageStageHash()
    const { vector, stages } = await computeVector(config, tree, rootHash, pipelineFileSha)
    const { reports, items } = await computeReportPlan(config.reports, tree, vector, rootHash, pipelineFileSha)
    return { vector, stages, reports, reportItems: items, scenes: config.scenes, coarse: false }
  } catch (err) {
    console.warn(`pipeline: coarse fallback for ${repo}@${headSha}: ${err instanceof Error ? err.message : err}`)
    return coarsePlan(headSha)
  }
}

// Index of the first stage whose hash differs from what the box has
// realized; null when nothing diverges (full reuse). A realized vector from
// a different stage list (renames, coarse↔fine transitions) diverges at 0.
export function firstDivergentStage(
  plan: StagePlan,
  realized: Record<string, string> | null,
): number | null {
  const names = Object.keys(plan.vector)
  if (!realized) return 0
  for (let i = 0; i < names.length; i++) {
    if (realized[names[i]!] !== plan.vector[names[i]!]) return i
  }
  return null
}
