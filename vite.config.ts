import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

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
  plugins: [tailwindcss()],
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
    rollupOptions: {
      input: {
        // The SPA shell, plus the per-run dashboard entry the worker's HTML
        // references by a stable name (no hash — the shell is generated
        // worker-side and can't read the manifest).
        index: fileURLToPath(new URL('./src/dashboard/index.html', import.meta.url)),
        run: fileURLToPath(new URL('./src/dashboard/run.ts', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'run' ? 'run-dashboard.js' : 'assets/[name]-[hash].js',
      },
    },
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
