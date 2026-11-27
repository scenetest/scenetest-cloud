import type { Env } from './env.ts'
import { issueFingerprint, type ReportItem, type ReportIssue } from './reports.ts'

export type { ReportItem }

// Write a stage's report batch into the global, content-addressed overview_*
// tables, keyed by (stage, input_hash) (#25). Upsert semantics: re-emitting the
// same report for the same hash (a re-run that didn't cache-skip the stage) is
// idempotent, and a metric/issue carries its hash, so the same write serves
// every PR that builds that content. Returns the number of overview rows
// touched. Best-effort per item — a malformed entry is skipped, not fatal, so
// one bad report never blocks a build.
export async function ingestReports(
  env: Env,
  stage: string,
  inputHash: string,
  reports: ReportItem[],
): Promise<number> {
  const now = Date.now()
  const stmts: D1PreparedStatement[] = []

  for (const item of reports) {
    if (item == null || typeof item !== 'object') continue
    switch (item.type) {
      case 'metric':
        if (typeof item.name !== 'string' || typeof item.value !== 'number') break
        stmts.push(
          env.DB.prepare(
            `INSERT INTO overview_metrics (stage, input_hash, name, value, unit, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(stage, input_hash, name)
               DO UPDATE SET value = excluded.value, unit = excluded.unit, created_at = excluded.created_at`,
          ).bind(stage, inputHash, item.name, item.value, item.unit ?? null, now),
        )
        break
      case 'summary':
        if (typeof item.kind !== 'string') break
        stmts.push(
          env.DB.prepare(
            `INSERT INTO overview_summaries (stage, input_hash, kind, summary_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(stage, input_hash, kind)
               DO UPDATE SET summary_json = excluded.summary_json, created_at = excluded.created_at`,
          ).bind(stage, inputHash, item.kind, JSON.stringify(item.summary ?? null), now),
        )
        break
      case 'issues': {
        if (typeof item.kind !== 'string' || !Array.isArray(item.issues)) break
        // A re-emitted issue set for the same hash must replace, not accumulate
        // (a fixed lint warning should vanish): clear this (stage,hash,kind)
        // first, then insert the current set. Dedup within the batch by
        // fingerprint so two identical issues don't collide on the PK.
        stmts.push(
          env.DB.prepare(
            'DELETE FROM overview_issues WHERE stage = ?1 AND input_hash = ?2 AND kind = ?3',
          ).bind(stage, inputHash, item.kind),
        )
        const seen = new Set<string>()
        for (const issue of item.issues as ReportIssue[]) {
          if (issue == null || typeof issue !== 'object') continue
          const fp = issueFingerprint(item.kind, issue)
          if (seen.has(fp)) continue
          seen.add(fp)
          stmts.push(
            env.DB.prepare(
              `INSERT INTO overview_issues
                 (stage, input_hash, kind, fingerprint, file, line, col, severity, message, raw, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
            ).bind(
              stage,
              inputHash,
              item.kind,
              fp,
              issue.file ?? null,
              typeof issue.line === 'number' ? issue.line : null,
              typeof issue.col === 'number' ? issue.col : null,
              issue.severity ?? null,
              issue.message ?? null,
              issue.raw ?? null,
              now,
            ),
          )
        }
        break
      }
    }
  }

  if (stmts.length === 0) return 0
  if (stmts.length === 1) await stmts[0]!.run()
  else await env.DB.batch(stmts)
  return stmts.length
}
