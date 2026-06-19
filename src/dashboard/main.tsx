import { render } from 'preact'
import { LocationProvider } from 'preact-iso'
import { QueryClientProvider } from '@tanstack/react-query'
import { App, spaScope } from './App.tsx'
import { queryClient } from './lib/queryClient.ts'

const root = document.getElementById('app')
if (root) {
  render(
    // `scope` limits preact-iso's link interception to the SPA's own routes.
    // Anything else (e.g. /auth/*, /api/*) is left to the browser so it reaches
    // the worker — see the worker's non-shell prefixes in src/worker/index.ts.
    <LocationProvider scope={spaScope}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </LocationProvider>,
    root,
  )
}
