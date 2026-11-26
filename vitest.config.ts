import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vitest/config'

// Loads shell scripts as strings, as wrangler's Text rules once did. The box
// agent is not in this list: tests import agent.mjs as a module, for its
// exported helpers.
const textModules: Plugin = {
  name: 'wrangler-text-modules',
  enforce: 'pre',
  transform(_code, id) {
    if (id.endsWith('.sh')) {
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
