import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import type { PrReports } from '../types.ts'

// The PR's static-analysis comparison (#25). Cheap D1 read, so it refetches on
// window focus like the other cloud queries; live report writes arrive as the
// box finishes its build stages, not over the run WebSocket.
export function usePrReports(owner: string, name: string, prNumber: number) {
  return useQuery<PrReports>({
    queryKey: ['cloud', 'pr-reports', owner, name, prNumber],
    queryFn: () =>
      api<PrReports>(`/api/cloud/repos/${owner}/${name}/pr/${prNumber}/reports`),
  })
}
