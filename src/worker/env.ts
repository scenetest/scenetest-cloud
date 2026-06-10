export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  // GitHub OAuth (identity)
  GITHUB_OAUTH_CLIENT_ID: string
  GITHUB_OAUTH_CLIENT_SECRET: string
  // First-login bootstrap: if allowed_user is empty AND the GitHub user's
  // login matches this value, they're inserted automatically. Subsequent
  // logins use the table normally.
  BOOTSTRAP_ALLOWED_LOGIN: string
  // TODO: required once the /webhook/github handler lands.
  GITHUB_WEBHOOK_SECRET?: string
  SESSION_SECRET: string
  ENABLE_DEBUG_ROUTES?: string
}

export interface AuthedUser {
  github_id: number
  github_login: string
}
