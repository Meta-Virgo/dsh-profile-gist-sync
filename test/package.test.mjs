/**
 * The published package, not the working copy.
 *
 * In this repository the plugin is developed in place, so a file the manifest
 * forgets to ship is still present and everything looks fine. A user gets only
 * what `files` allows. This check packs the package the way a registry would,
 * unpacks it somewhere else, and runs the plugin from THAT tree — then asserts
 * the package carries no author-specific state.
 *
 * Skipped (not failed) when neither npm nor pnpm is available.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createReport, makeProfile, tempDir, useProfile, callRoute, serveHandler } from './harness.mjs'

const { check, finish } = createReport('package')

const PLUGIN = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const manifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))
const workspace = tempDir('dpg-pack-')
const packDir = join(workspace, 'pack')
const installed = join(workspace, 'installed')
mkdirSync(packDir, { recursive: true })
mkdirSync(installed, { recursive: true })

/**
 * A tarball when this machine has npm or pnpm, otherwise a staged copy built
 * from the manifest's own `files` list. The fallback proves the same thing the
 * tarball does — that nothing the runtime needs is missing from `files` — and
 * keeps the check useful on a machine with no package manager at all.
 */
function pack() {
  const commands = process.platform === 'win32' ? ['npm.cmd', 'pnpm.cmd'] : ['npm', 'pnpm']
  for (const command of commands) {
    try {
      execFileSync(command, ['pack', '--pack-destination', packDir], { cwd: PLUGIN, stdio: ['ignore', 'pipe', 'pipe'] })
      const tarballs = readdirSync(packDir).filter(name => name.endsWith('.tgz'))
      if (tarballs.length > 0) {
        execFileSync('tar', ['-xzf', join(packDir, tarballs[0]), '-C', installed, '--strip-components=1'], { stdio: ['ignore', 'pipe', 'pipe'] })
        return { mode: 'tarball', by: command, size: statSync(join(packDir, tarballs[0])).size }
      }
    } catch {
      // Try the next package manager, then the manifest fallback.
    }
  }
  let staged = 0
  for (const entry of manifest.files ?? []) {
    if (entry.includes('*')) {
      const [directory, pattern] = entry.split('/')
      const suffix = pattern.replace('*', '')
      for (const name of readdirSync(join(PLUGIN, directory))) {
        if (!name.endsWith(suffix)) continue
        mkdirSync(join(installed, directory), { recursive: true })
        cpSync(join(PLUGIN, directory, name), join(installed, directory, name))
        staged += 1
      }
      continue
    }
    const source = join(PLUGIN, entry)
    if (!existsSync(source)) continue
    if (statSync(source).isDirectory()) {
      cpSync(source, join(installed, entry), { recursive: true })
      staged += 1
    } else {
      cpSync(source, join(installed, entry))
      staged += 1
    }
  }
  return staged === 0 ? null : { mode: 'manifest', by: 'the files list', size: null }
}

const packed = pack()
if (packed === null) {
  console.log('skip  the manifest lists no files to stage and no package manager is available')
  console.log('\npackage: SKIPPED')
  process.exit(0)
}
check(packed.mode === 'tarball'
  ? `the package can be packed (${packed.by})`
  : `the manifest's files list only (no package manager; staged ${packed.by})`, true)

const listing = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? listing(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`])
const shipped = listing(installed)

// ---- everything the runtime needs is inside the tarball ----------------
check('the host entry is shipped', shipped.includes('index.js'))
check('every lib module is shipped',
  shipped.filter(file => file.startsWith('lib/')).length === readdirSync(join(PLUGIN, 'lib')).filter(name => name.endsWith('.js')).length,
  shipped.filter(file => file.startsWith('lib/')).join(', '))
check('the client half is shipped', shipped.includes('client.js'))
check('the bundle patch is shipped', shipped.includes('cordis.patch.yml'))
check('the locales are shipped', shipped.includes('locale/zh.json') && shipped.includes('locale/en.json'))
check('the icon and the readme are shipped', shipped.includes('icon.svg') && shipped.includes('README.md'))
check('the licence travels with it', shipped.includes('LICENSE'))
check('the checks travel with it, so a reader can run them', shipped.some(file => file.startsWith('test/')))
if (packed.size !== null) check('the tarball stays small', packed.size < 200 * 1024, `${packed.size} bytes`)
check('no working state leaked into the package',
  !shipped.some(file => file.includes('.dsh-config-sync') || file.includes('node_modules') || file.endsWith('settings.json')),
  shipped.join(', '))

// ---- the packed copy actually runs -------------------------------------
const root = `file:///${installed.replace(/\\/g, '/').replace(/\/$/, '')}`
const { apply } = await import(`${root}/index.js`)
const { BASE_PATH } = await import(`${root}/lib/routes.js`)
const home = tempDir('dpg-pack-profile-')
const profile = makeProfile(join(home, 'profiles', 'test'))
useProfile(profile, home)
let handler = null
const seen = { routes: 0, tools: 0 }
const ctx = {
  get(name) {
    if (name === 'webServer') return { register: (route) => { handler = route.handler; seen.routes += 1; return () => {} } }
    if (name === 'tools') return { register: () => { seen.tools += 1; return () => {} } }
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose !== 'function') throw new Error('Invalid effect')
    return dispose
  },
}
let applyError = null
try {
  apply(ctx)
} catch (error) {
  applyError = error
}
check('the packed host half activates', applyError === null, applyError?.message)
check('and registers its route and tool', seen.routes === 1 && seen.tools === 1, `routes=${seen.routes} tools=${seen.tools}`)
const served = await serveHandler(handler)
const status = await callRoute(served.base, `${BASE_PATH}/api/status`)
check('the packed copy answers its own status route',
  status.status === 200 && status.payload.profile === 'test', `${status.status} ${JSON.stringify(status.payload).slice(0, 120)}`)
served.close()

const clientSource = readFileSync(join(installed, 'client.js'), 'utf8')
let clientThrew = null
try {
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', clientSource)
} catch (error) {
  clientThrew = error
}
check('the packed client half parses', clientThrew === null, clientThrew?.message)
check('and announces the package name it was installed as',
  clientSource.includes(`id: '${manifest.name}'`), manifest.name)

// ---- nothing about the author travels ----------------------------------
// The checks themselves use invented ids, so those are excluded by name: a real
// Gist id or a personal path appearing anywhere in the package is a leak.
const FIXTURES = new Set(['a1b2c3d4e5f60718293a4b5c6d7e8f90'])
const text = shipped.map(file => readFileSync(join(installed, file), 'utf8')).join('\n')
const leaks = (text.match(/[A-Za-z]:\\\\?Users\\\\?[^"'\s]+|gho_[A-Za-z0-9]{20,}|\b[0-9a-f]{32}\b/g) ?? [])
  .filter(value => !FIXTURES.has(value))
check('no personal path, token, or Gist id is baked into the package', leaks.length === 0, leaks.slice(0, 3).join(', '))

process.exit(finish())
