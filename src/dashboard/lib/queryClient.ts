import { QueryClient } from '@tanstack/react-query'
import type { ApiError } from './api.ts'

// Don't retry on 4xx (the request was wrong, not transient). Always retry
// twice on 5xx / network errors.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        const status = (error as Partial<ApiError>).status
        if (status != null && status >= 400 && status < 500) return false
        return failureCount < 2
      },
    },
  },
})
