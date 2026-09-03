import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.ts'

export interface Config {
  // The worker is running with debug routes on, so /auth/dev-login exists.
  dev_auth: boolean
}

export function useConfig(): Config {
  const q = useQuery<Config>({
    queryKey: ['config'],
    queryFn: () => api<Config>('/api/config'),
    staleTime: Infinity,
  })
  return q.data ?? { dev_auth: false }
}
