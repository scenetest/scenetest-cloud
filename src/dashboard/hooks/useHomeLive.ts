import { useEffect, useState } from 'preact/hooks'
import { subscribeHome } from '../lib/homeTransport.ts'
import type { HomeTile } from '../types.ts'

export const homeTileKey = (repo: string, prNumber: number) => `${repo}#${prNumber}`

// Live home tiles keyed `repo#pr`, kept current over the home WebSocket. The
// snapshot replaces the set; tiles upsert (last-write-wins on updatedAt);
// removes delete. Components overlay these onto the D1 snapshot from
// useOverview/useRepo — snapshot for the initial paint, deltas for "stays live."
export function useHomeLive(): Map<string, HomeTile> {
  const [tiles, setTiles] = useState<Map<string, HomeTile>>(() => new Map())

  useEffect(() => {
    return subscribeHome((msg) => {
      setTiles((prev) => {
        const next = new Map(prev)
        if (msg.kind === 'snapshot') {
          next.clear()
          for (const t of msg.tiles) next.set(homeTileKey(t.repo, t.prNumber), t)
        } else if (msg.kind === 'tile') {
          const k = homeTileKey(msg.tile.repo, msg.tile.prNumber)
          const cur = next.get(k)
          if (!cur || msg.tile.updatedAt >= cur.updatedAt) next.set(k, msg.tile)
        } else if (msg.kind === 'remove') {
          next.delete(homeTileKey(msg.repo, msg.prNumber))
        }
        return next
      })
    })
  }, [])

  return tiles
}
