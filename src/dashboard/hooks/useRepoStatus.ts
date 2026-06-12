import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import type { RepoSetupStatus } from '../types.ts'

// The add-a-project checklist polls while the wizard is open: the user is
// off configuring a webhook on GitHub or committing a pipeline file, and
// the checks flip green here as their work lands.
export function useRepoStatus(owner: string, name: string, enabled: boolean) {
  return useQuery<RepoSetupStatus>({
    queryKey: ['admin', 'repo-status', owner, name],
    queryFn: () => api<RepoSetupStatus>(`/api/admin/repos/${owner}/${name}/status`),
    enabled,
    refetchInterval: 4000,
  })
}
