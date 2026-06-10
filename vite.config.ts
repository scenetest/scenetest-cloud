import { defineConfig } from 'vite'

// Dev runs as two servers: vite (SPA + HMR) and `wrangler dev` (worker, :8787).
// Everything that isn't a static asset is proxied to the worker. Host is NOT
// rewritten (no changeOrigin), so the worker sees the vite origin and the
// OAuth redirect_uri stays on the vite port — add
// http://localhost:<vite-port>/auth/github/callback to the GitHub App's
// callback URL list for the proxied login flow to work.
const workerProxy = {
  target: 'http://localhost:8787',
} as const

export default defineConfig({
  root: 'src/dashboard',
  server: {
    proxy: {
      '/api': workerProxy,
      '/auth': workerProxy,
      '/webhook': workerProxy,
      '/r': workerProxy,
    },
  },
  build: {
    outDir: '../../dist/dashboard',
    emptyOutDir: true,
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
    },
  },
})
