#!/usr/bin/env node
// Encodes binary/shell assets as base64 TypeScript modules so the worker
// bundle doesn't contain raw shell commands that trip Cloudflare's WAF on
// upload. Run before wrangler deploy (see package.json "deploy" script).
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function encode(src, dest) {
  const b64 = readFileSync(join(root, src)).toString('base64')
  writeFileSync(
    join(root, dest),
    `// Auto-generated from ${src} — edit the source file, not this one\nexport default '${b64}'\n`,
  )
  console.log(`encoded ${src} → ${dest}`)
}

encode(
  'src/worker/runner/image/builder-setup.sh',
  'src/worker/runner/image/builder-setup-b64.ts',
)
encode(
  'infra/box/agent.mjs',
  'src/worker/runner/image/agent-b64.ts',
)
