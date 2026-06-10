export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GOOGLE_ALLOWED_EMAILS: string
  GITHUB_WEBHOOK_SECRET: string
  SESSION_SECRET: string
  ENABLE_DEBUG_ROUTES?: string
}
