import { useQuery } from '@tanstack/react-query'
import { api, type ApiError } from '../lib/api.ts'

export interface Me {
  github_id: number
  github_login: string
}

export type MeState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'signed-in'; me: Me }
  | { kind: 'error'; message: string }

export function useMe(): MeState {
  // A 401 isn't a failure for the auth probe — it's the "signed out" branch.
  // We let useQuery surface the ApiError and discriminate on status here so
  // the rest of the SPA can read .kind without thinking about query plumbing.
  const q = useQuery<Me, ApiError>({
    queryKey: ['me'],
    queryFn: () => api<Me>('/api/me'),
  })
  if (q.isPending) return { kind: 'loading' }
  if (q.isError) {
    if (q.error.status === 401) return { kind: 'signed-out' }
    return { kind: 'error', message: q.error.message }
  }
  return { kind: 'signed-in', me: q.data }
}
