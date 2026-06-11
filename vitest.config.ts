import { readFileSync } from 'node:fs'
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
  test: {
    include: ['src/**/*.test.ts'],
  },
})
