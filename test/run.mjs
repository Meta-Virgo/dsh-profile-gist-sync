/**
 * Run every check in this directory.
 *
 * Each `*.test.mjs` is a separate process, so one crash cannot hide the others,
 * and every check is offline: profiles are temporary directories, the GitHub
 * layer is stubbed, and the only host any check talks to is its own loopback
 * server. A check may report itself as skipped (no package manager to pack
 * with); that is not a failure.
 *
 *   node test/run.mjs
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const files = readdirSync(here).filter(name => name.endsWith('.test.mjs')).sort()

let failed = 0
for (const file of files) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' })
  const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`
  if (result.status !== 0) {
    failed += 1
    console.log(`\n>>> ${file} FAILED (${elapsed})\n`)
  }
}

console.log(`\n${files.length} check file(s), ${files.length - failed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
