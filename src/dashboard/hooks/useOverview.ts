import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import type { OverviewStats } from '../types.ts'

export function useOverview() {
  return useQuery<OverviewStats>({
    queryKey: ['cloud', 'overview'],
    queryFn: () => api<OverviewStats>('/api/cloud/overview'),
  })
}
