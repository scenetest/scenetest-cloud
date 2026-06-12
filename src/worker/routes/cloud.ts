import type { AuthedHandler } from '../auth/session.ts'

export const getOverview: AuthedHandler = async (_req, env) => {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

  const [reposResult, openPrsResult, statsResult] = await Promise.all([
    env.DB.prepare(
      'SELECT owner, name, github_repo_id, added_at FROM watched_repo ORDER BY owner, name',
    ).all<{ owner: string; name: string; github_repo_id: number | null; added_at: number }>(),

    env.DB.prepare(`
      SELECT
        p.repo, p.pr_number, p.head_sha, p.base_ref, p.state, p.updated_at,
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
  ])

  const total = statsResult?.total_runs ?? 0
  const passed = statsResult?.passed_runs ?? 0

  return Response.json({
    repos: reposResult.results ?? [],
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
        p.repo, p.pr_number, p.head_sha, p.base_ref, p.state, p.updated_at,
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
      ORDER BY started_at DESC
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

// GET /api/cloud/repos/:owner/:name/metrics?base=main
// The main-branch metric timeline: every merge's sampled metrics, grouped by
// metric name and ordered oldest→newest so the dashboard can chart each as a
// line over commits/time. Empty until merges with reported metrics exist.
export const getRepoMetrics: AuthedHandler = async (req, env, _ctx, params) => {
  const repo = `${params.owner!}/${params.name!}`
  const baseRef = new URL(req.url).searchParams.get('base') ?? 'main'

  const rows = await env.DB.prepare(
    `SELECT name, commit_sha, pr_number, value, recorded_at
       FROM metric_history
      WHERE repo = ?1 AND base_ref = ?2
      ORDER BY name ASC, recorded_at ASC, rowid ASC`,
  )
    .bind(repo, baseRef)
    .all<{ name: string; commit_sha: string; pr_number: number | null; value: number; recorded_at: number }>()

  const byName = new Map<string, Array<{ commit_sha: string; pr_number: number | null; value: number; recorded_at: number }>>()
  for (const r of rows.results ?? []) {
    const point = { commit_sha: r.commit_sha, pr_number: r.pr_number, value: r.value, recorded_at: r.recorded_at }
    const list = byName.get(r.name)
    if (list) list.push(point)
    else byName.set(r.name, [point])
  }

  return Response.json({
    repo,
    base_ref: baseRef,
    metrics: [...byName.entries()].map(([name, points]) => ({ name, points })),
  })
}
