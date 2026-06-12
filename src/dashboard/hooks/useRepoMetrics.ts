import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import type { RepoMetrics } from '../types.ts'

export function useRepoMetrics(owner: string, name: string) {
  return useQuery<RepoMetrics>({
    queryKey: ['cloud', 'repo-metrics', owner, name],
    queryFn: () => api<RepoMetrics>(`/api/cloud/repos/${owner}/${name}/metrics`),
  })
}
