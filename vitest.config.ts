import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'

// Mirror wrangler's [[rules]] Text modules (wrangler.toml): the builder
// script and box agent are imported as strings by the worker, so vitest has
// to load them the same way when a test's import chain reaches them.
const textModules: Plugin = {
  name: 'wrangler-text-modules',
  enforce: 'pre',
  transform(_code, id) {
    if (id.endsWith('.sh') || id.endsWith('infra/box/agent.mjs')) {
      return {
        code: `export default ${JSON.stringify(readFileSync(id, 'utf8'))}`,
        map: null,
      }
    }
  },
}

export default defineConfig({
  plugins: [textModules],
  resolve: {
    alias: {
      // partyserver imports the `cloudflare:workers` runtime module; node's
      // ESM loader rejects that scheme. Point it at a shim for unit tests.
      'cloudflare:workers': fileURLToPath(
        new URL('./test/cloudflare-workers-shim.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    // Force partyserver through vite's transform so the alias above can
    // rewrite its `cloudflare:workers` import; otherwise it's externalized
    // and node's loader rejects the scheme.
    server: { deps: { inline: ['partyserver'] } },
  },
})
