import type { AuthedHandler } from '../auth/session.ts'
import {
  buildReportComparison,
  reportHashes,
  type MetricRow,
  type SummaryRow,
  type IssueRow,
} from '../reports.ts'

export const getOverview: AuthedHandler = async (_req, env) => {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

  const [reposResult, openPrsResult, statsResult, webhookRepos, runRepos, boxRows] = await Promise.all([
    env.DB.prepare(
      'SELECT owner, name, github_repo_id, added_at FROM watched_repo ORDER BY owner, name',
    ).all<{ owner: string; name: string; github_repo_id: number | null; added_at: number }>(),

    env.DB.prepare(`
      SELECT
        p.repo, p.pr_number, p.head_sha, p.base_ref, p.state, p.title, p.updated_at,
        COUNT(r.id) as run_count,
        SUM(CASE WHEN r.status = 'passed' THEN 1 ELSE 0 END) as pass_count,
        SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) as fail_count,
        (
          SELECT r2.status FROM runs r2
          WHERE r2.repo = p.repo AND r2.pr_number = p.pr_number
          ORDER BY r2.started_at DESC LIMIT 1
        ) as latest_status
      FROM prs p
      LEFT JOIN runs r ON r.repo = p.repo AND r.pr_number = p.pr_number
      WHERE p.state = 'open'
      GROUP BY p.repo, p.pr_number
      ORDER BY p.updated_at DESC
    `).all(),

    env.DB.prepare(`
      SELECT
        COUNT(*) as total_runs,
        SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) as passed_runs,
        (
          SELECT COUNT(DISTINCT se.scene_id)
          FROM scene_executions se
          JOIN runs r2 ON r2.id = se.run_id
          WHERE r2.started_at > ?1
            AND se.scene_id IN (
              SELECT scene_id FROM scene_executions
              WHERE started_at > ?1
              GROUP BY scene_id
              HAVING SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) > 0
                AND SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) > 0
            )
        ) as flaky_count
      FROM runs
      WHERE started_at > ?1
    `).bind(sevenDaysAgo).first<{ total_runs: number; passed_runs: number; flaky_count: number }>(),

    // Setup-progress evidence, in bulk: a repo onboards through registered →
    // webhook → pipeline → first run (the add-a-project checklist). Repos
    // still mid-onboarding show step dots instead of PR pips in the lists.
    env.DB.prepare('SELECT DISTINCT repo FROM webhook_deliveries WHERE repo IS NOT NULL')
      .all<{ repo: string }>(),
    env.DB.prepare('SELECT DISTINCT repo FROM runs').all<{ repo: string }>(),
    env.DB.prepare(`
      SELECT b.repo, b.realized_stages FROM boxes b
      JOIN (SELECT repo, MAX(created_at) AS mc FROM boxes GROUP BY repo) latest
        ON b.repo = latest.repo AND b.created_at = latest.mc
    `).all<{ repo: string; realized_stages: string | null }>(),
  ])

  const total = statsResult?.total_runs ?? 0
  const passed = statsResult?.passed_runs ?? 0

  // Repo names are case-insensitive on GitHub and rows may carry non-canonical
  // casing, so match the evidence sets case-folded.
  const lc = (s: string) => s.toLowerCase()
  const webhookSet = new Set((webhookRepos.results ?? []).map((r) => lc(r.repo)))
  const runSet = new Set((runRepos.results ?? []).map((r) => lc(r.repo)))
  const pipelineSet = new Set<string>()
  for (const b of boxRows.results ?? []) {
    if (!b.realized_stages) continue
    let keys: string[]
    try { keys = Object.keys(JSON.parse(b.realized_stages)) } catch { continue }
    // Reserved '*'-prefixed pseudo-stages (default/coarse plans) don't count
    // as a real user pipeline — same rule as the per-repo status endpoint.
    if (keys.length > 0 && !keys.every((k) => k.startsWith('*'))) pipelineSet.add(lc(b.repo))
  }

  const repos = (reposResult.results ?? []).map((r) => {
    const key = lc(`${r.owner}/${r.name}`)
    const first_run = runSet.has(key)
    return {
      ...r,
      setup: { webhook: webhookSet.has(key), pipeline: pipelineSet.has(key), first_run },
      // Once a first run has landed the repo is live; before that it's still
      // onboarding and the UI shows progress.
      ready: first_run,
    }
  })

  return Response.json({
    repos,
    open_prs: openPrsResult.results ?? [],
    total_runs_7d: total,
    pass_rate_7d: total > 0 ? Math.round((passed / total) * 100) : null,
    flaky_count: statsResult?.flaky_count ?? 0,
  })
}

export const getRepoPrs: AuthedHandler = async (_req, env, _ctx, params) => {
  const owner = params.owner!
  const name = params.name!
  const repo = `${owner}/${name}`

  const [repoRow, openPrsResult, recentRunsResult] = await Promise.all([
    env.DB.prepare(
      'SELECT owner, name, github_repo_id, added_at FROM watched_repo WHERE owner = ?1 AND name = ?2',
    ).bind(owner, name).first<{ owner: string; name: string; github_repo_id: number | null; added_at: number }>(),

    env.DB.prepare(`
      SELECT
        p.repo, p.pr_number, p.head_sha, p.base_ref, p.state, p.title, p.updated_at,
        COUNT(r.id) as run_count,
        SUM(CASE WHEN r.status = 'passed' THEN 1 ELSE 0 END) as pass_count,
        SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) as fail_count,
        (
          SELECT r2.status FROM runs r2
          WHERE r2.repo = p.repo AND r2.pr_number = p.pr_number
          ORDER BY r2.started_at DESC LIMIT 1
        ) as latest_status
      FROM prs p
      LEFT JOIN runs r ON r.repo = p.repo AND r.pr_number = p.pr_number
      WHERE p.repo = ?1 AND p.state = 'open'
      GROUP BY p.pr_number
      ORDER BY p.updated_at DESC
    `).bind(repo).all(),

    env.DB.prepare(`
      SELECT id, pr_number, head_sha, status, started_at, ended_at
      FROM runs
      WHERE repo = ?1
      ORDER BY COALESCE(started_at, ended_at) DESC
      LIMIT 20
    `).bind(repo).all(),
  ])

  if (!repoRow) return Response.json({ error: 'repo_not_found' }, { status: 404 })

  return Response.json({
    repo: repoRow,
    open_prs: openPrsResult.results ?? [],
    recent_runs: recentRunsResult.results ?? [],
  })
}

// GET /api/cloud/repos/:owner/:name/pr/:number/reports — the PR's
// static-analysis comparison (#25): "report at base hash vs report at head
// hash", per stage. The PR's most recent run carries the head/base stage
// vectors (computeStagePlan output, stored at run creation); the overview_*
// tables hold one report per (stage, input_hash), shared across runs and PRs.
// We resolve the run's vectors, fetch every overview row at the hashes they
// name, and pair them in buildReportComparison. `available:false` when the PR
// has no run with a vector yet.
export const getPrReports: AuthedHandler = async (_req, env, _ctx, params) => {
  const repo = `${params.owner}/${params.name}`
  const prNumber = Number(params.number)
  if (!Number.isFinite(prNumber)) return Response.json({ error: 'bad pr number' }, { status: 400 })

  const run = await env.DB.prepare(
    `SELECT id, head_sha, base_sha, head_vector_json, base_vector_json
       FROM runs
      WHERE repo = ?1 AND pr_number = ?2 AND head_vector_json IS NOT NULL
      ORDER BY rowid DESC LIMIT 1`,
  )
    .bind(repo, prNumber)
    .first<{ id: string; head_sha: string; base_sha: string | null; head_vector_json: string; base_vector_json: string | null }>()

  if (!run) {
    return Response.json({
      available: false,
      comparison: { metrics: [], summaries: [], issues: [], baseMissing: true },
    })
  }

  let headVector: Record<string, string>
  let baseVector: Record<string, string> | null
  try {
    headVector = JSON.parse(run.head_vector_json) as Record<string, string>
    baseVector = run.base_vector_json ? (JSON.parse(run.base_vector_json) as Record<string, string>) : null
  } catch {
    return Response.json({
      available: false,
      comparison: { metrics: [], summaries: [], issues: [], baseMissing: true },
    })
  }

  const hashes = [...new Set(reportHashes(headVector, baseVector).map((h) => h.hash))]
  if (hashes.length === 0) {
    return Response.json({
      available: true,
      head_sha: run.head_sha,
      base_sha: run.base_sha,
      comparison: buildReportComparison(headVector, baseVector, { metrics: [], summaries: [], issues: [] }),
    })
  }

  // Fetch every overview row at the referenced hashes; the builder keys by
  // (stage, hash), so an input_hash IN (…) filter is enough.
  const placeholders = hashes.map((_, i) => `?${i + 1}`).join(', ')
  const [metrics, summaries, issues] = await Promise.all([
    env.DB.prepare(
      `SELECT stage, input_hash, name, value, unit FROM overview_metrics WHERE input_hash IN (${placeholders})`,
    ).bind(...hashes).all<MetricRow>(),
    env.DB.prepare(
      `SELECT stage, input_hash, kind, summary_json FROM overview_summaries WHERE input_hash IN (${placeholders})`,
    ).bind(...hashes).all<SummaryRow>(),
    env.DB.prepare(
      `SELECT stage, input_hash, kind, fingerprint, file, line, col, severity, message, raw
         FROM overview_issues WHERE input_hash IN (${placeholders})`,
    ).bind(...hashes).all<IssueRow>(),
  ])

  const comparison = buildReportComparison(headVector, baseVector, {
    metrics: metrics.results ?? [],
    summaries: summaries.results ?? [],
    issues: issues.results ?? [],
  })

  return Response.json({ available: true, head_sha: run.head_sha, base_sha: run.base_sha, comparison })
}
