import { render } from 'preact'
import { QueryClientProvider } from '@tanstack/react-query'
import { App } from './App.tsx'
import { queryClient } from './lib/queryClient.ts'

const root = document.getElementById('app')
if (root) {
  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
    root,
  )
}
