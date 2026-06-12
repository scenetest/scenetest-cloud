import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import type { RepoDetail } from '../types.ts'

export function useRepo(owner: string, name: string) {
  return useQuery<RepoDetail>({
    queryKey: ['cloud', 'repo', owner, name],
    queryFn: () => api<RepoDetail>(`/api/cloud/repos/${owner}/${name}`),
  })
}
