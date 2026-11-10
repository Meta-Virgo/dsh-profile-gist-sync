/**
 * The two things a cross-machine restore has to get right besides the files.
 *
 * 1. A dependency spec that only resolves on the machine that wrote it must not
 *    travel. `link:E:/work/plugin` reaching another machine overwrites its own
 *    `^1.0.0` — the union merge lets the incoming side win — and every later
 *    `pnpm install` there fails on a path that does not exist.
 * 2. A restore writes a manifest, not an installation. The plugins the manifest
 *    names have to be listed and installable, and a host that publishes no
 *    plugin manager has to be told apart from a host that says nothing is
 *    missing.
 *
 * The union guarantee is re-checked here as a regression: this plugin is only
 * allowed to drop what it does not understand from an *export*, never to drop a
 * local plugin during a restore.
 *
 * Everything is offline. The one host any check talks to is its own loopback
 * stub, and the plugin manager is a local object.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createReport, makeProfile, tempDir, useProfile, callRoute, serveHandler } from './harness.mjs'

const { check, finish } = createReport('plugins')
const backup = await import('../lib/backup.js')
const plugins = await import('../lib/plugins.js')

const workspace = tempDir('dpg-plugins-')
const home = join(workspace, 'home')

/**
 * The publisher's machine: this very plugin is a local link into a checkout, one
 * plugin is a plain registry range, and `dsh.profile.bundles` still names the
 * linked plugin — the case the task requires to be left alone.
 */
const linkedCheckout = join(workspace, 'dsh-config-sync')
const linkedSpec = `link:${linkedCheckout.replaceAll('\\', '/')}`
mkdirSync(linkedCheckout, { recursive: true })
writeFileSync(join(linkedCheckout, 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-gist-sync',
  version: '1.0.0',
}, null, 2)}\n`)

const linkedProfile = makeProfile(join(home, 'profiles', 'linked'), {
  dependencies: { 'dsh-profile-gist-sync': linkedSpec, 'some-plugin': '^1.0.0' },
  bundles: ['@deepseek-ai/dsh-base', 'dsh-profile-gist-sync'],
})

// ---- 1. what an upload must not carry ----------------------------------
useProfile(linkedProfile, home)
const exported = backup.exportBackupWithReport()
const manifestEntry = exported.backup.files.find(file => file.path === 'package.json')
const exportedDeps = manifestEntry.json.dependencies

check('a link: dependency is not in the exported document',
  exportedDeps['dsh-profile-gist-sync'] === undefined, JSON.stringify(exportedDeps))
check('a normal semver dependency is untouched', exportedDeps['some-plugin'] === '^1.0.0', exportedDeps['some-plugin'])
check('nothing else in package.json changes',
  manifestEntry.json.name === 'dsh-profile-test'
  && manifestEntry.json.private === true
  && JSON.stringify(manifestEntry.json.dsh.profile.bundles) === JSON.stringify(['@deepseek-ai/dsh-base', 'dsh-profile-gist-sync']),
  JSON.stringify(manifestEntry.json))
check('the bundle list keeps the name whose dependency was dropped',
  manifestEntry.json.dsh.profile.bundles.includes('dsh-profile-gist-sync'))
check('the drop is reported to the caller',
  exported.dropped.length === 1 && exported.dropped[0].name === 'dsh-profile-gist-sync',
  JSON.stringify(exported.dropped))
check('the report names the dropped spec', exported.dropped[0]?.spec === linkedSpec, exported.dropped[0]?.spec)
check('and the plugin it pointed at, read from its own package.json',
  exported.dropped[0]?.package === 'dsh-profile-gist-sync' && exported.dropped[0]?.version === '1.0.0',
  `${exported.dropped[0]?.package}@${exported.dropped[0]?.version}`)
check('the report carries an exclusion code, like every other exclusion',
  exported.dropped[0]?.code === 'local-dependency', exported.dropped[0]?.code)
check('the document itself carries no extra top-level key',
  Object.keys(exported.backup).sort().join() === 'createdAt,files,format,profile,version',
  Object.keys(exported.backup).join())
check('the package.json entry carries no extra field',
  Object.keys(manifestEntry).sort().join() === 'json,path', Object.keys(manifestEntry).join())
check('exportBackup still returns the document alone',
  backup.exportBackup().format === backup.BACKUP_FORMAT && backup.exportBackup().dropped === undefined)

// An absolute path with no `link:` prefix is the other half of the same rule.
const absoluteProfile = makeProfile(join(home, 'profiles', 'absolute'), {
  dependencies: {
    'tarball-plugin': join(workspace, 'somewhere', 'tarball-plugin-1.0.0.tgz'),
    'file-plugin': 'file:../file-plugin',
    'workspace-plugin': 'workspace:*',
    'registry-plugin': '1.2.3',
  },
  bundles: ['@deepseek-ai/dsh-base'],
})
useProfile(absoluteProfile, home)
const absolute = backup.exportBackupWithReport()
const absoluteDeps = absolute.backup.files.find(file => file.path === 'package.json').json.dependencies
check('an absolute-path spec is not in the exported document', absoluteDeps['tarball-plugin'] === undefined, JSON.stringify(absoluteDeps))
check('a file: spec is not either', absoluteDeps['file-plugin'] === undefined)
check('nor is a workspace: spec', absoluteDeps['workspace-plugin'] === undefined)
check('a registry spec beside them survives', absoluteDeps['registry-plugin'] === '1.2.3', absoluteDeps['registry-plugin'])
check('every drop is reported once', absolute.dropped.length === 3 && absolute.droppedEntries === 3,
  `${absolute.dropped.length}/${absolute.droppedEntries}`)
check('a spec whose target is not there is still dropped, with no package claimed',
  absolute.dropped.find(entry => entry.name === 'tarball-plugin')?.package === null,
  JSON.stringify(absolute.dropped.find(entry => entry.name === 'tarball-plugin')))
check('the classifier agrees on the forms the task names', [
  'link:../x', 'file:/a/b', 'portal:./x', 'workspace:*', 'E:/x', 'C:\\x', '/x', './x', '../x',
].every(spec => backup.isMachineLocalSpec(spec) === true))
check('and refuses a registry range, tag, or alias', [
  '^1.0.0', '~2.1.0', 'latest', 'next', 'npm:@scope/name@1.0.0', 'github:someone/repo',
].every(spec => backup.isMachineLocalSpec(spec) === false))

// ---- 2. a restore still unions, never deletes ---------------------------
/**
 * A document as another machine would publish it, naming `shared-plugin` and one
 * plugin this machine has never seen. No machine-local spec is in it, because an
 * upload cannot carry one — that is what section 1 proves.
 */
const incoming = {
  format: backup.BACKUP_FORMAT,
  version: backup.BACKUP_VERSION,
  createdAt: '2026-01-01T00:00:00.000Z',
  profile: 'other',
  files: [{
    path: 'package.json',
    json: {
      name: 'dsh-profile-test',
      private: true,
      dependencies: { 'shared-plugin': '^2.0.0', 'cloud-only-plugin': '3.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'cloud-only-plugin'] } },
    },
  }],
}

// The target already has a plugin that exists nowhere else, declared as its own
// local link, plus a shared plugin pinned at its own spec.
const unionProfile = makeProfile(join(home, 'profiles', 'union'), {
  dependencies: { 'local-only-plugin': 'link:../local-only-plugin', 'shared-plugin': '1.0.0' },
  bundles: ['@deepseek-ai/dsh-base', 'local-only-plugin'],
})
useProfile(unionProfile, home)
check('the plan merges the manifest rather than replacing it', backup.planRestore(incoming).manifest !== null)
backup.applyRestore(incoming)
const merged = JSON.parse(readFileSync(join(unionProfile, 'package.json'), 'utf8'))
check('a local-only plugin survives a restore', merged.dependencies['local-only-plugin'] !== undefined,
  JSON.stringify(merged.dependencies))
// Documented, not just asserted: the manifest merge spreads the current map first
// and the incoming one second, so when BOTH sides declare the same plugin the
// incoming spec wins. That is precisely the mechanism the export-side drop exists
// to make safe, and it is the behavior a reader of this file should know about.
check('the incoming spec wins for a plugin both sides declare',
  merged.dependencies['shared-plugin'] === '^2.0.0', merged.dependencies['shared-plugin'])
check('a plugin only the cloud has is added', merged.dependencies['cloud-only-plugin'] === '3.0.0')
check('the bundle list is unioned, keeping the local-only name',
  merged.dsh.profile.bundles.includes('local-only-plugin') && merged.dsh.profile.bundles.includes('cloud-only-plugin'),
  JSON.stringify(merged.dsh.profile.bundles))

// The bug this change fixes, stated as a check: feed a target a document this
// plugin itself exported from the linked machine. The publisher's link: spec is
// not in it, so nothing here is overwritten with a path into another machine.
useProfile(linkedProfile, home)
const reexported = backup.exportBackup()
const freshProfile = makeProfile(join(home, 'profiles', 'fresh'), {
  dependencies: { 'shared-plugin': '1.0.0' },
  bundles: ['@deepseek-ai/dsh-base'],
})
useProfile(freshProfile, home)
backup.applyRestore(reexported)
const fresh = readFileSync(join(freshProfile, 'package.json'), 'utf8')
check('restoring a real upload carries no machine-local spec',
  !fresh.includes('link:') && !fresh.includes(linkedCheckout.replaceAll('\\', '/')), fresh)
check('and the plugin the publisher dropped does not appear as a dependency',
  JSON.parse(fresh).dependencies['dsh-profile-gist-sync'] === undefined, fresh)
check('while the rest of the publisher’s manifest does arrive',
  JSON.parse(fresh).dependencies['some-plugin'] === '^1.0.0', fresh)

// ---- 3. the missing-plugin computation ---------------------------------
useProfile(linkedProfile, home)
check('declared plugins come from dependencies first, in manifest order',
  plugins.declaredPlugins(linkedProfile)[0]?.name === 'dsh-profile-gist-sync'
  && plugins.declaredPlugins(linkedProfile)[0]?.kind === 'both',
  JSON.stringify(plugins.declaredPlugins(linkedProfile)))
check('a name only the bundle list declares is still declared',
  plugins.declaredPlugins(unionProfile).some(entry => entry.name === 'local-only-plugin'),
  JSON.stringify(plugins.declaredPlugins(unionProfile).map(entry => entry.name)))

/** A plugin manager double; omitted rows stay omitted the way a host would. */
function stubManager({ plugins: rows = null, bundles = [], installBehavior = null } = {}) {
  const installed = []
  const state = { bundles: new Map(bundles.map(bundle => [bundle.name, bundle])) }
  return {
    installed,
    state,
    async listPlugins() {
      // A host that publishes no loader list reports null, not an empty array:
      // "I have no loader" and "the loader has nothing" are different answers.
      return rows
    },
    async listBundles() {
      return [...state.bundles.values()]
    },
    async installBundle(spec) {
      installed.push(spec)
      return installBehavior === null
        ? { changed: true, application: 'restart-required' }
        : installBehavior(spec, state)
    },
  }
}

/** A host context offering only what the code under test asks for. */
function hostOf(pluginManager) {
  return { get: (name) => (name === 'pluginManager' ? pluginManager : undefined), pluginManager }
}

// A profile declaring one installable plugin and one local link, on a machine
// where the link target does not exist.
const mixedProfile = makeProfile(join(home, 'profiles', 'mixed'), {
  dependencies: { 'some-plugin': '^1.0.0', 'dsh-profile-gist-sync': linkedSpec },
  bundles: ['@deepseek-ai/dsh-base'],
})
useProfile(mixedProfile, home)

{
  const manager = stubManager({
    plugins: [{ moduleName: '@deepseek-ai/dsh-base' }],
    bundles: [
      { name: '@deepseek-ai/dsh-base', availability: 'installed', installed: true, version: '1.0.0' },
      // The manager reports the recorded spec as `source`, prefixed with the
      // name; a link: target it cannot resolve is reported as `missing`.
      { name: 'dsh-profile-gist-sync', availability: 'missing', installed: true, source: `dsh-profile-gist-sync@${linkedSpec}` },
    ],
  })
  const inventory = await plugins.pluginInventory(hostOf(manager))
  check('the inventory says it could check', inventory.available === true, JSON.stringify(inventory.reason))
  check('it reports both inventory sources separately',
    inventory.sources.plugins === true && inventory.sources.bundles === true, JSON.stringify(inventory.sources))
  check('exactly the two declared plugins that are absent are missing',
    JSON.stringify(inventory.missing.map(entry => entry.name)) === JSON.stringify(['some-plugin', 'dsh-profile-gist-sync']),
    JSON.stringify(inventory.missing.map(entry => entry.name)))
  check('the local link is missing but not installable here',
    inventory.missing[1]?.resolvable === false && inventory.missing[1]?.note === 'local-path'
    && inventory.missing[1]?.installSpec === null,
    JSON.stringify(inventory.missing[1]))
  check('the registry dependency is installable, and its spec is reconstructed',
    inventory.missing[0]?.resolvable === true && inventory.missing[0]?.installSpec === 'some-plugin@^1.0.0',
    JSON.stringify(inventory.missing[0]))
  check('the counts separate missing from installable',
    inventory.counts.declared === 3 && inventory.counts.missing === 2
    && inventory.counts.installable === 1 && inventory.counts.unresolved === 1,
    JSON.stringify(inventory.counts))
  // `@deepseek-ai/dsh-base` is the one bundle this machine reports as installed.
  check('the installed list names what is there',
    JSON.stringify(inventory.installed) === JSON.stringify(['@deepseek-ai/dsh-base']),
    JSON.stringify(inventory.installed))

  // Running the install over a set with one impossible entry must touch only the
  // possible one.
  const ran = await plugins.installMissingPlugins(hostOf(manager))
  check('the unresolvable plugin is skipped, never handed to the manager',
    ran.outcomeCounts.skipped === 1 && !manager.installed.some(spec => spec.includes('link:')),
    `${JSON.stringify(ran.outcomeCounts)} / ${JSON.stringify(manager.installed)}`)
  check('a skipped result carries the reason instead of a message',
    ran.results.find(result => result.outcome === 'skipped')?.message === 'local-path',
    JSON.stringify(ran.results))
}

{
  // A machine that answers "nothing is missing" installs nothing at all.
  const presentProfile = makeProfile(join(home, 'profiles', 'present'), {
    dependencies: { 'some-plugin': '^1.0.0' },
    bundles: ['@deepseek-ai/dsh-base'],
  })
  useProfile(presentProfile, home)
  const manager = stubManager({
    plugins: [{ moduleName: '@deepseek-ai/dsh-base' }, { moduleName: 'some-plugin' }],
    bundles: [
      { name: '@deepseek-ai/dsh-base', availability: 'installed', installed: true, version: '1.0.0' },
      { name: 'some-plugin', availability: 'installed', installed: true, version: '1.0.0' },
    ],
  })
  const ran = await plugins.installMissingPlugins(hostOf(manager))
  check('a machine with nothing missing installs nothing',
    manager.installed.length === 0 && ran.results.length === 0, JSON.stringify(manager.installed))
  check('and reports zero of every outcome',
    Object.values(ran.outcomeCounts).every(count => count === 0), JSON.stringify(ran.outcomeCounts))
  check('and does not ask for a restart', ran.restart === false)
}

{
  // A plugin present on disk but composed by nothing: the third piece of
  // evidence keeps it from being reported as missing. Its own profile, so no
  // later check sees this machine as already having the package.
  const onDiskProfile = makeProfile(join(home, 'profiles', 'on-disk'), {
    dependencies: { 'some-plugin': '^1.0.0', 'dsh-profile-gist-sync': linkedSpec },
    bundles: ['@deepseek-ai/dsh-base'],
  })
  useProfile(onDiskProfile, home)
  mkdirSync(join(onDiskProfile, 'node_modules', 'some-plugin'), { recursive: true })
  writeFileSync(join(onDiskProfile, 'node_modules', 'some-plugin', 'package.json'), '{"name":"some-plugin","version":"1.0.0"}\n')
  const manager = stubManager({ plugins: [], bundles: [] })
  const inventory = await plugins.pluginInventory(hostOf(manager))
  check('a package installed on disk is not called missing',
    !inventory.missing.some(entry => entry.name === 'some-plugin'),
    JSON.stringify(inventory.missing.map(entry => entry.name)))
  check('the link: dependency is still missing, since its target is absent',
    inventory.missing.some(entry => entry.name === 'dsh-profile-gist-sync'),
    JSON.stringify(inventory.missing.map(entry => entry.name)))
}

{
  // A registry-spec plugin that is genuinely absent, then installed: the second
  // run is a no-op because the manager now reports it present.
  useProfile(mixedProfile, home)
  const manager = stubManager({
    plugins: [{ moduleName: '@deepseek-ai/dsh-base' }],
    bundles: [{ name: 'some-plugin', availability: 'missing', installed: true, source: 'some-plugin@^1.0.0' }],
    installBehavior: (spec, state) => {
      state.bundles.set('some-plugin', { name: 'some-plugin', availability: 'installed', installed: true, version: '1.0.0' })
      return { changed: true, application: 'restart-required', version: '1.0.0' }
    },
  })
  const ran = await plugins.installMissingPlugins(hostOf(manager))
  check('the install hands the manager the spec the manifest declares',
    manager.installed.includes('some-plugin@^1.0.0'), JSON.stringify(manager.installed))
  check('the outcome is "installed"',
    ran.results.find(result => result.name === 'some-plugin')?.outcome === 'installed', JSON.stringify(ran.results))
  check('and it asks for a restart', ran.restart === true)
  check('the answer re-reads the inventory instead of assuming success',
    !ran.missing.some(entry => entry.name === 'some-plugin'),
    JSON.stringify(ran.missing.map(entry => entry.name)))

  manager.installed.length = 0
  const second = await plugins.installMissingPlugins(hostOf(manager))
  check('a second run installs nothing', manager.installed.length === 0, JSON.stringify(manager.installed))
  check('and reports nothing to do',
    !second.results.some(result => result.name === 'some-plugin'), JSON.stringify(second.results.map(result => result.name)))
}
{
  // The manager refusing because the package is already there. Its own profile,
  // so the link: dependency mixedProfile declares does not enter the tally.
  const presentProfile = makeProfile(join(home, 'profiles', 'refused'), {
    dependencies: { 'some-plugin': '^1.0.0' },
    bundles: ['@deepseek-ai/dsh-base'],
  })
  useProfile(presentProfile, home)
  const manager = stubManager({
    plugins: [{ moduleName: '@deepseek-ai/dsh-base' }],
    bundles: [
      { name: '@deepseek-ai/dsh-base', availability: 'installed', installed: true, version: '1.0.0' },
      { name: 'some-plugin', availability: 'missing', installed: true, source: 'some-plugin@^1.0.0' },
    ],
    installBehavior: () => ({ changed: false, application: 'failed', error: { code: 'already-installed' } }),
  })
  const ran = await plugins.installMissingPlugins(hostOf(manager))
  check('only the genuinely missing plugin is attempted', manager.installed.length === 1, JSON.stringify(manager.installed))
  check('a manager refusal of an installed package reads as already-present',
    ran.outcomeCounts['already-present'] === 1 && ran.outcomeCounts.failed === 0, JSON.stringify(ran.outcomeCounts))
  check('and it does not ask for a restart', ran.restart === false)
}
{
  // A failure carries the manager's own diagnostic.
  const failingProfile = makeProfile(join(home, 'profiles', 'failing'), {
    dependencies: { 'some-plugin': '^1.0.0' },
    bundles: ['@deepseek-ai/dsh-base'],
  })
  useProfile(failingProfile, home)
  const manager = stubManager({
    plugins: [{ moduleName: '@deepseek-ai/dsh-base' }],
    bundles: [
      { name: '@deepseek-ai/dsh-base', availability: 'installed', installed: true, version: '1.0.0' },
      { name: 'some-plugin', availability: 'missing', installed: true, source: 'some-plugin@^1.0.0' },
    ],
    installBehavior: () => ({ changed: false, application: 'failed', error: { code: 'operation-error', diagnostic: 'ERR_PNPM_FETCH_404' } }),
  })
  const ran = await plugins.installMissingPlugins(hostOf(manager))
  check('a failed install keeps the diagnostic',
    ran.results.find(result => result.outcome === 'failed')?.message === 'ERR_PNPM_FETCH_404', JSON.stringify(ran.results))
  check('and is counted as failed, not as installed', ran.outcomeCounts.failed === 1, JSON.stringify(ran.outcomeCounts))

  // A manager that throws is the same outcome with the thrown message.
  const throwing = stubManager({
    plugins: [{ moduleName: '@deepseek-ai/dsh-base' }],
    bundles: [
      { name: '@deepseek-ai/dsh-base', availability: 'installed', installed: true, version: '1.0.0' },
      { name: 'some-plugin', availability: 'missing', installed: true, source: 'some-plugin@^1.0.0' },
    ],
    installBehavior: () => { throw new Error('the lock is held') },
  })
  const strict = await plugins.installMissingPlugins(hostOf(throwing))
  check('a manager that throws is reported, not propagated',
    strict.results.some(result => result.outcome === 'failed' && result.message === 'the lock is held'),
    JSON.stringify(strict.results))
}
{
  // A bundle row with no `source` still has the manifest spec to fall back on.
  useProfile(mixedProfile, home)
  const bare = stubManager({ bundles: [{ name: 'some-plugin', availability: 'missing' }, { name: 'dsh-profile-gist-sync', availability: 'missing' }] })
  const ran = await plugins.installMissingPlugins(hostOf(bare))
  check('with no reported source the manifest spec is used',
    ran.results.find(result => result.name === 'some-plugin')?.installSpec === 'some-plugin@^1.0.0',
    JSON.stringify(ran.results))
  check('and the local link is still refused, not installed by name',
    !bare.installed.includes('dsh-profile-gist-sync'), JSON.stringify(bare.installed))
}

// ---- 4. the service-absent cases ---------------------------------------
{
  const inventory = await plugins.pluginInventory(hostOf(undefined))
  check('without a plugin manager the answer says it could not check',
    inventory.available === false && inventory.reason === 'no-plugin-manager', JSON.stringify(inventory))
  check('and it carries no missing list to misread as an empty one', inventory.missing === undefined,
    JSON.stringify(Object.keys(inventory)))
  const ran = await plugins.installMissingPlugins(hostOf(undefined))
  check('the install route degrades the same way',
    ran.available === false && ran.results.length === 0 && ran.restart === false,
    JSON.stringify(ran.outcomeCounts))
}
{
  // A manager whose inventory throws answers no better than no manager — and a
  // host whose service lookup itself throws is the same case again.
  const broken = {
    async listPlugins() { throw new Error('loader is gone') },
    async listBundles() { throw new Error('loader is gone') },
    async installBundle() { throw new Error('nope') },
  }
  const inventory = await plugins.pluginInventory({ get: () => broken, pluginManager: broken })
  check('a manager that cannot list is reported as unable to check',
    inventory.available === false && inventory.reason === 'plugin-manager-error', JSON.stringify(inventory))
  const throwingHost = { get() { throw new Error('no service registry') } }
  const degraded = await plugins.pluginInventory(throwingHost)
  check('a context whose service lookup throws is "no plugin manager", not a crash',
    degraded.available === false && degraded.reason === 'no-plugin-manager', JSON.stringify(degraded))
}
{
  // `ctx.get` is the style the rest of this plugin uses; a host publishing the
  // service that way only must still answer.
  const manager = stubManager({ plugins: [], bundles: [{ name: 'some-plugin', availability: 'installed', installed: true }] })
  const viaGet = await plugins.pluginInventory({ get: (name) => (name === 'pluginManager' ? manager : undefined) })
  check('a manager found through ctx.get still answers', viaGet.available === true, JSON.stringify(viaGet.reason))
}

// ---- 5. the routes over HTTP -------------------------------------------
{
  useProfile(mixedProfile, home)
  const manager = stubManager({
    plugins: [{ moduleName: '@deepseek-ai/dsh-base' }],
    bundles: [{ name: 'some-plugin', availability: 'missing', installed: true, source: 'some-plugin@^1.0.0' }],
    installBehavior: (spec, state) => {
      state.bundles.set('some-plugin', { name: 'some-plugin', availability: 'installed', installed: true, version: '1.0.0' })
      return { changed: true, application: 'restart-required' }
    },
  })
  const { registerRoutes, BASE_PATH } = await import('../lib/routes.js')
  let handler = null
  registerRoutes({
    get: (name) => {
      if (name === 'webServer') return { register: (route) => { handler = route.handler; return () => {} } }
      if (name === 'pluginManager') return manager
      return undefined
    },
    pluginManager: manager,
  })
  const served = await serveHandler(handler)
  const call = (path, body) => callRoute(served.base, `${BASE_PATH}${path}`, body)

  const inventory = await call('/api/plugins')
  check('GET /api/plugins answers', inventory.status === 200 && inventory.payload.available === true,
    `${inventory.status} ${JSON.stringify(inventory.payload).slice(0, 120)}`)
  check('it lists the declared plugin this machine lacks',
    inventory.payload.missing.some(entry => entry.name === 'some-plugin'),
    JSON.stringify(inventory.payload.missing.map(entry => entry.name)))

  const install = await call('/api/plugins/install', {})
  check('POST /api/plugins/install answers', install.status === 200 && Array.isArray(install.payload.results),
    `${install.status} ${JSON.stringify(install.payload).slice(0, 120)}`)
  check('it installed the one it could', install.payload.outcomeCounts.installed === 1, JSON.stringify(install.payload.outcomeCounts))
  check('it never called the manager for the machine-local dependency',
    !manager.installed.some(spec => spec.includes('link:')), JSON.stringify(manager.installed))
  check('the response says what happened to each spec',
    install.payload.results.every(result => typeof result.name === 'string' && typeof result.outcome === 'string'))

  const second = await call('/api/plugins/install', {})
  check('a second run is safe and adds no duplicate spec',
    second.status === 200 && new Set(manager.installed).size === manager.installed.length,
    `${second.status} ${JSON.stringify(manager.installed)}`)

  // A host with no plugin manager still answers, and says it could not check.
  let bareHandler = null
  registerRoutes({
    get: (name) => (name === 'webServer' ? { register: (route) => { bareHandler = route.handler; return () => {} } } : undefined),
  })
  const bare = await serveHandler(bareHandler)
  const bareInventory = await callRoute(bare.base, `${BASE_PATH}/api/plugins`)
  check('a host without a plugin manager answers "cannot check"',
    bareInventory.status === 200 && bareInventory.payload.available === false,
    `${bareInventory.status} ${JSON.stringify(bareInventory.payload)}`)
  const bareInstall = await callRoute(bare.base, `${BASE_PATH}/api/plugins/install`, {})
  check('and its install route does nothing rather than failing',
    bareInstall.status === 200 && bareInstall.payload.results.length === 0, String(bareInstall.status))
  bare.close()
  served.close()
}

// ---- 6. the page's copy stays in step with its two dictionaries ---------
{
  // `client.js` is browser code, so it is read as text: the dictionaries are
  // plain object literals, and a key added to one language but not the other is
  // the failure this guards — it shows up as an English string in a Chinese page.
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const blockOf = (locale) => {
    const start = source.indexOf(`      ${locale}: {`)
    if (start < 0) return ''
    return source.slice(start, source.indexOf('\n      },', start))
  }
  const keysOf = (block) => new Set([...block.matchAll(/^\s{8}(?:'([^']+)'|([A-Za-z][A-Za-z0-9]*)):/gm)].map(match => match[1] ?? match[2]))
  const zh = keysOf(blockOf('zh'))
  const en = keysOf(blockOf('en'))
  check('both dictionaries exist and carry strings', zh.size > 100 && en.size > 100, `${zh.size}/${en.size}`)
  check('the two dictionaries have exactly the same keys',
    [...zh].filter(key => !en.has(key)).length === 0 && [...en].filter(key => !zh.has(key)).length === 0,
    `only zh: ${[...zh].filter(key => !en.has(key)).join(', ')}; only en: ${[...en].filter(key => !zh.has(key)).join(', ')}`)
  // Every literal `t('...')` in the panel has to resolve, or the page prints the
  // key itself. `err.*` and `note.*` are built from a code at runtime and are
  // checked for existence rather than for a literal call.
  const literal = [...source.matchAll(/\bt\('([^']+)'\)/g)].map(match => match[1])
  check('every literal lookup resolves in both languages',
    literal.every(key => zh.has(key) && en.has(key)),
    literal.filter(key => !zh.has(key) || !en.has(key)).join(', '))
  const dynamic = [...source.matchAll(/t\(`(err|note)\.\$\{/g)].map(match => match[1])
  for (const prefix of new Set(dynamic)) {
    check(`the runtime ${prefix}.<code> lookups all have copy in both languages`,
      [...zh].filter(key => key.startsWith(`${prefix}.`)).length > 0
      && [...zh].filter(key => key.startsWith(`${prefix}.`)).length === [...en].filter(key => key.startsWith(`${prefix}.`)).length,
      `${[...zh].filter(key => key.startsWith(`${prefix}.`)).length} zh / ${[...en].filter(key => key.startsWith(`${prefix}.`)).length} en`)
  }
  check('the auth error copy names the three token sources in Chinese',
    ['DSH_GITHUB_TOKEN', 'gh auth login', '高级设置'].every(hint => blockOf('zh').includes(hint)))
  check('and the new-machine checklist is in both dictionaries',
    blockOf('zh').includes('newMachineStep1') && blockOf('en').includes('newMachineStep1'))
}

// ---- 7. the token error is actionable ----------------------------------
{
  const gist = await import('../lib/gist.js')
  const saved = {
    user: process.env.USERPROFILE,
    home: process.env.HOME,
    path: process.env.PATH,
    host: process.env.DSH_GITHUB_TOKEN,
    plain: process.env.GITHUB_TOKEN,
  }
  // All three token sources are emptied, and gh is hidden, so the message read
  // here is the one a machine with no token at all really produces.
  const nowhere = join(workspace, 'no-gh-here')
  mkdirSync(nowhere, { recursive: true })
  process.env.USERPROFILE = nowhere
  process.env.HOME = nowhere
  process.env.PATH = ''
  delete process.env.DSH_GITHUB_TOKEN
  delete process.env.GITHUB_TOKEN
  let error = null
  try {
    await gist.resolveTokenSource(undefined)
  } catch (caught) {
    error = caught
  }
  const message = String(error?.message ?? '')
  check('a missing token is an auth error', error?.code === 'auth', String(error?.code))
  check('it names all three token sources',
    message.includes('DSH_GITHUB_TOKEN') && message.includes('gh auth login') && message.includes('高级设置'),
    message)
  check('it names the scope the token needs', message.includes('`gist` scope'), message)
  check('it gives a link that pre-selects the scope',
    message.includes('https://github.com/settings/tokens/new?scopes=gist'), message)
  for (const [key, value] of [['USERPROFILE', saved.user], ['HOME', saved.home], ['PATH', saved.path]]) {
    if (value !== undefined) process.env[key] = value
  }
  if (saved.host !== undefined) process.env.DSH_GITHUB_TOKEN = saved.host
  if (saved.plain !== undefined) process.env.GITHUB_TOKEN = saved.plain
}

process.exit(finish())
