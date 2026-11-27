#!/usr/bin/env node
// Source files must stay plain text. A raw control byte (a NUL from a mangled
// escape sequence, for one) makes git treat the file as binary, so diffs and
// PR review stop showing it. Write the escape sequence, never the raw byte.
// Exits non-zero and lists file:line for every offender. Runs first in
// `pnpm test`, so CI and local checks both enforce it.

import { readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const ROOTS = ['src', 'infra', 'scripts', 'migrations', 'docs', '.github']
const TEXT_EXTS = new Set(['.ts', '.tsx', '.mjs', '.js', '.sql', '.md', '.sh', '.css', '.html', '.json', '.yml', '.yaml', '.toml'])
const SKIP_DIRS = new Set(['node_modules', 'dist', '.wrangler'])

function textFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...textFiles(p))
    } else if (e.isFile() && TEXT_EXTS.has(extname(e.name))) {
      out.push(p)
    }
  }
  return out
}

const offenders = []
let checked = 0
for (const root of ROOTS) {
  for (const file of textFiles(root)) {
    checked += 1
    const bytes = readFileSync(file)
    const bad = bytes.findIndex((b) => (b < 0x20 && b !== 0x09 && b !== 0x0a) || b === 0x7f)
    if (bad >= 0) {
      const line = bytes.subarray(0, bad).toString('utf8').split('\n').length
      offenders.push(`${file}:${line} (byte 0x${bytes[bad].toString(16).padStart(2, '0')})`)
    }
  }
}

if (offenders.length > 0) {
  console.error(`Control bytes found in ${offenders.length} source file(s):\n  ${offenders.join('\n  ')}`)
  process.exit(1)
}
console.log(`${checked} source files are plain text`)
