export interface Repo {
  owner: string
  name: string
  github_repo_id: number | null
  added_at: number
}

export interface PrSummary {
  repo: string
  pr_number: number
  head_sha: string
  base_ref: string
  state: string
  updated_at: number
  run_count: number
  pass_count: number
  fail_count: number
  latest_status: string | null
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
