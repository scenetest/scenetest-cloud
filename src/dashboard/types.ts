// Onboarding progress for a repo (registered is implicit — the row exists).
// Drives the "setting up" step dots while a repo isn't live yet.
export interface RepoSetup {
  webhook: boolean
  pipeline: boolean
  first_run: boolean
}

export interface Repo {
  owner: string
  name: string
  github_repo_id: number | null
  added_at: number
  setup: RepoSetup
  ready: boolean
}

export interface PrSummary {
  repo: string
  pr_number: number
  head_sha: string
  base_ref: string
  state: string
  title: string | null
  updated_at: number
  run_count: number
  pass_count: number
  fail_count: number
  latest_status: string | null
}

// A live home-view tile pushed by the HomeCoordinator over the home WebSocket.
// Mirrors the worker's HomeTile (src/worker/do/home-coordinator.ts). Overlaid on
// the D1 snapshot from useOverview/useRepo so tiles move without a refetch.
export interface HomeTile {
  repo: string
  prNumber: number
  runId: string | null
  status: string
  pct: number
  failing: number
  updatedAt: number
}

export interface OverviewStats {
  repos: Repo[]
  open_prs: PrSummary[]
  total_runs_7d: number
  pass_rate_7d: number | null
  flaky_count: number
}

export interface RecentRun {
  id: string
  pr_number: number
  head_sha: string
  status: string
  started_at: number | null
  ended_at: number | null
}

export interface RepoDetail {
  repo: Repo
  open_prs: PrSummary[]
  recent_runs: RecentRun[]
}

// Static-analysis reports for a PR (GET …/pr/:number/reports). Mirrors the
// worker's ReportComparison (src/worker/reports.ts): one report per stage input
// hash, paired base-vs-head. See architecture.md, "The build pipeline".
export interface ReportIssue {
  file?: string
  line?: number
  col?: number
  severity?: string
  message?: string
  raw?: string
}

export interface MetricComparison {
  stage: string
  name: string
  unit: string | null
  base: number | null
  head: number | null
  delta: number | null
}

export interface SummaryComparison {
  stage: string
  kind: string
  base: unknown | null
  head: unknown | null
}

export interface IssuesComparison {
  stage: string
  kind: string
  added: ReportIssue[]
  resolved: ReportIssue[]
  unchanged: number
}

export interface ReportComparison {
  metrics: MetricComparison[]
  summaries: SummaryComparison[]
  issues: IssuesComparison[]
  baseMissing: boolean
}

export interface PrReports {
  available: boolean
  head_sha?: string
  base_sha?: string | null
  comparison: ReportComparison
}

// Add-a-project wizard checklist (GET /api/admin/repos/:owner/:name/status).
export interface RepoSetupStatus {
  registered: boolean
  webhook: { seen: boolean; last_event?: string; last_at?: number }
  pipeline: {
    state: 'active' | 'present' | 'absent' | 'unknown'
    source: 'box' | 'github'
  }
  first_run: { id: string; status: string; started_at: number | null } | null
}
