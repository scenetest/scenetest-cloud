import { Server, type Connection } from 'partyserver'
import type { Env } from '../env.ts'

// The home view's live layer. ONE singleton instance (idFromName('global'))
// sitting above all the per-PR coordinators: they push coarse run-status
// rollups in (DO-to-DO, onRequest), and this object fans them out to the home
// dashboard's partysocket subscribers (broadcast). The webhook handler pokes it
// when a PR opens/closes so the list ticks live too.
//
// It owns NO canonical state. The tile set is a last-write-wins cache rebuilt
// from D1 — the same projections the PR coordinators already write — so eviction
// is harmless: it just rebuilds on next use. Only the coarse rollup crosses up
// here; raw per-PR events never leave a PR's own viewers (see architecture.md,
// "The home view"). partyserver gives us the connection-holding + broadcast +
// hibernation plumbing; the per-PR coordinator stays hand-rolled.

// One tile per PR — its current run status and progress. Mirrors the client's
// HomeTile (src/dashboard/types.ts); kept in sync by hand (small, stable).
export interface HomeTile {
  repo: string
  prNumber: number
  runId: string | null
  status: string // queued | running | passed | failed | cancelled
  pct: number // 0..100
  failing: number
  updatedAt: number
}

type ServerMsg =
  | { kind: 'snapshot'; tiles: HomeTile[] }
  | { kind: 'tile'; tile: HomeTile }
  | { kind: 'remove'; repo: string; prNumber: number }

const tileKey = (repo: string, prNumber: number) => `${repo}#${prNumber}`

function pctOf(status: string | null, sceneCount: number | null, settled: number): number {
  if (sceneCount && sceneCount > 0) return Math.min(100, Math.round((settled / sceneCount) * 100))
  return status === 'passed' || status === 'failed' || status === 'cancelled' ? 100 : 0
}

export class HomeCoordinator extends Server<Env> {
  static override options = { hibernate: true }

  // Last-write-wins tile per PR. Rebuilt from D1 on first use (and again after
  // eviction); never the source of truth.
  private tiles = new Map<string, HomeTile>()
  private loaded = false
  private loading?: Promise<void>

  // Rebuild lazily and exactly once per live instance. In-memory flag, so after
  // eviction the next access rebuilds again — no dependence on onStart firing.
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (!this.loading) {
      this.loading = this.rebuild().then(
        () => { this.loaded = true; this.loading = undefined },
        (err) => { this.loading = undefined; throw err },
      )
    }
    await this.loading
  }

  // Rebuild every open PR's tile from D1: the latest run's status + progress.
  private async rebuild(): Promise<void> {
    const rows = await this.env.DB.prepare(LATEST_RUN_BY_PR + " WHERE p.state = 'open'").all<TileRow>()
    const now = Date.now()
    this.tiles.clear()
    for (const r of rows.results ?? []) this.tiles.set(tileKey(r.repo, r.prNumber), rowToTile(r, now))
  }

  // Browser connect: replay the current snapshot, then deltas ride broadcast().
  // ensureLoaded() awaits first, so even a cold object sends a complete snapshot.
  override async onConnect(connection: Connection): Promise<void> {
    await this.ensureLoaded()
    const msg: ServerMsg = { kind: 'snapshot', tiles: [...this.tiles.values()] }
    connection.send(JSON.stringify(msg))
  }

  // The home view is read-only; clients send nothing meaningful.
  override onMessage(): void {}

  // DO-to-DO surface: PR coordinators POST /rollup; the webhook handler POSTs
  // /refresh on a PR list change.
  override async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (req.method === 'POST' && url.pathname.endsWith('/rollup')) {
      await this.ensureLoaded()
      const { tile } = (await req.json()) as { tile: HomeTile }
      this.applyTile(tile)
      return Response.json({ ok: true })
    }
    if (req.method === 'POST' && url.pathname.endsWith('/refresh')) {
      await this.ensureLoaded()
      const { repo, prNumber } = (await req.json()) as { repo: string; prNumber: number }
      await this.refreshPr(repo, prNumber)
      return Response.json({ ok: true })
    }
    return new Response('Not Found', { status: 404 })
  }

  // Upsert + broadcast. Last-write-wins on updatedAt so a tile rebuilt from D1
  // can't clobber a newer rollup that landed during the rebuild.
  private applyTile(tile: HomeTile): void {
    const k = tileKey(tile.repo, tile.prNumber)
    const prev = this.tiles.get(k)
    if (prev && prev.updatedAt > tile.updatedAt) return
    this.tiles.set(k, tile)
    const msg: ServerMsg = { kind: 'tile', tile }
    this.broadcast(JSON.stringify(msg))
  }

  // PR list change: re-read this PR from D1. Still open → upsert + broadcast its
  // tile (a freshly opened PR appears live); gone (closed/merged) → drop it and
  // broadcast a removal so the tile disappears live.
  private async refreshPr(repo: string, prNumber: number): Promise<void> {
    const row = await this.env.DB.prepare(LATEST_RUN_BY_PR + ' WHERE p.repo = ?1 AND p.pr_number = ?2')
      .bind(repo, prNumber)
      .first<TileRow & { state: string }>()
    const k = tileKey(repo, prNumber)
    if (!row || row.state !== 'open') {
      if (this.tiles.delete(k)) {
        const msg: ServerMsg = { kind: 'remove', repo, prNumber }
        this.broadcast(JSON.stringify(msg))
      }
      return
    }
    this.applyTile(rowToTile(row, Date.now()))
  }
}

interface TileRow {
  repo: string
  prNumber: number
  state?: string
  runId: string | null
  status: string | null
  sceneCount: number | null
  settled: number
  failing: number
}

function rowToTile(r: TileRow, now: number): HomeTile {
  return {
    repo: r.repo,
    prNumber: r.prNumber,
    runId: r.runId,
    status: r.status ?? 'queued',
    pct: pctOf(r.status, r.sceneCount, r.settled),
    failing: r.failing ?? 0,
    updatedAt: now,
  }
}

// Each PR joined to its latest run (by started_at, rowid as tiebreaker) plus the
// settled/failing scene counts that drive the progress %. Callers append a WHERE.
const LATEST_RUN_BY_PR = `
  SELECT p.repo AS repo, p.pr_number AS prNumber, p.state AS state,
         lr.id AS runId, lr.status AS status, lr.scene_count AS sceneCount,
         (SELECT COUNT(*) FROM scene_executions se
            WHERE se.run_id = lr.id AND se.status IN ('passed','failed','skipped')) AS settled,
         (SELECT COUNT(*) FROM scene_executions se
            WHERE se.run_id = lr.id AND se.status = 'failed') AS failing
    FROM prs p
    LEFT JOIN runs lr ON lr.id = (
      SELECT r2.id FROM runs r2
       WHERE r2.repo = p.repo AND r2.pr_number = p.pr_number
       ORDER BY r2.started_at DESC, r2.rowid DESC LIMIT 1)`
