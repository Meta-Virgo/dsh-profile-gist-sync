/**
 * Which of the profile's declared plugins this machine actually has, and the one
 * action that closes the gap.
 *
 * A restore writes a manifest, not an installation. `package.json` and
 * `dsh.profile.bundles` arrive as text; the packages they name do not, because
 * installed plugins are never part of a backup. DSH survives that — it logs
 * `skipping profile bundle "..."` and boots — but the plugins are not there, so
 * the page has to be able to answer the question a restore raises and cannot
 * settle by itself: what is declared here that this machine does not have?
 *
 * The answer comes from the host's `pluginManager` service when the deployment
 * publishes one. That service is optional, so "cannot check" is a first-class
 * answer here: it is `available: false` with a reason and no verdict at all,
 * because "nothing is missing" and "nobody looked" are different statements and
 * only one of them deserves a green line. Nothing in this module throws for a
 * service that is absent, that throws, or that answers a shape it does not
 * recognize — the page has to be told, not taken down.
 *
 * Installing is deliberately additive. The only mutation performed here is
 * `installBundle`, one spec at a time; nothing is ever removed or disabled, no
 * bundle selection is rewritten, and the spec handed over is the one the
 * manifest already declares (or the manager's own `source` for that dependency),
 * so a successful install saves the same value back instead of resolving a new
 * range behind the reader's back.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMachineLocalSpec, profileRoot } from './backup.js'

/** Outcome vocabulary the install route answers with, in report order. */
export const INSTALL_OUTCOMES = ['installed', 'already-present', 'failed', 'skipped']

/** Outcome notes the client localizes, keyed as `note.<value>`. */
export const LOCAL_SPEC_NOTES = {
  'local-path': 'local-path',
  'workspace-protocol': 'workspace-protocol',
}

/**
 * A `name@link:…`-shaped machine-local spec. The plugin manager's own `source`
 * field is a whole `pnpm add` argument, so it prefixes the package name to the
 * recorded value; `isMachineLocalSpec` alone would not see the `link:` through
 * that prefix.
 */
const PREFIXED_LOCAL_RE = /^(?:@[^/\\]+[/\\])?[^@/\\]+@(?:link|file|portal|workspace):/i

/** A spec pnpm resolves by itself: a URL, a git address, or a tarball. */
const SELF_RESOLVING_RE = /^(?:https?:\/\/|git\+|git:\/\/|ssh:\/\/|github:|gitlab:|bitbucket:)/i

/** A value this module accepts as a package name. */
const PACKAGE_NAME_RE = /^(?:@[^/\\]+[/\\])?[^/\\@]+$/

/** A dependency map, or an empty one for anything else. */
function dependencyMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** A thrown value's message, whatever was thrown. */
function messageOf(error) {
  if (error instanceof Error && typeof error.message === 'string') return error.message
  return String(error)
}

/**
 * The package name a manager row names, or null when the row names no package.
 *
 * `listPlugins()` reports a module specifier, which for a profile dependency is
 * the dependency name but can also carry a subpath (`@scope/pkg/lib/x.js`) or be
 * a relative path or file URL for something composed from the profile itself.
 * Only the first one or two segments of a plausible package specifier are kept;
 * everything else is refused rather than guessed at, because a wrong name here
 * would mask a genuinely missing plugin.
 * @param {unknown} value - a row field.
 */
function packageNameOf(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.startsWith('.') || trimmed.includes('://') || /^[A-Za-z]:/.test(trimmed)) return null
  const parts = trimmed.replaceAll('\\', '/').split('/').filter(part => part !== '')
  if (parts.length === 0) return null
  const name = parts[0].startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]
  return PACKAGE_NAME_RE.test(name) ? name : null
}

/**
 * The note for a machine-local spec, or null when the spec is installable.
 * @param {string} value - the spec, with or without a `name@` prefix.
 */
function localNote(value) {
  const prefixed = PREFIXED_LOCAL_RE.test(value)
  if (!prefixed && !isMachineLocalSpec(value)) return null
  return /(?:^|@)workspace:/i.test(value) ? LOCAL_SPEC_NOTES['workspace-protocol'] : LOCAL_SPEC_NOTES['local-path']
}

/**
 * The profile's declared plugins, in manifest order.
 *
 * Dependencies come first because they carry the spec an install needs. A name
 * only `dsh.profile.bundles` names follows with no spec at all — that is exactly
 * what a dropped machine-local dependency leaves behind, and it is a statement
 * of intent DSH tolerates, so it is listed rather than hidden.
 * @param {string} root - the profile directory.
 * @returns {Array<{ name: string, spec: string | null, kind: 'dependency' | 'bundle' | 'both' }>}
 */
export function declaredPlugins(root) {
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    // An unreadable profile manifest has no declared plugins; the route that
    // needed it reports the missing profile separately.
    return []
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return []
  const dependencies = dependencyMap(manifest.dependencies)
  const profile = dependencyMap(dependencyMap(manifest.dsh).profile)
  const bundles = Array.isArray(profile.bundles)
    ? profile.bundles.filter(name => typeof name === 'string' && name.trim() !== '')
    : []
  const declared = []
  for (const [name, spec] of Object.entries(dependencies)) {
    declared.push({
      name,
      spec: typeof spec === 'string' ? spec : null,
      kind: bundles.includes(name) ? 'both' : 'dependency',
    })
  }
  for (const name of bundles) {
    if (dependencies[name] !== undefined) continue
    declared.push({ name, spec: null, kind: 'bundle' })
  }
  return declared
}

/**
 * The install spec to hand `pluginManager.installBundle`, or why this machine
 * cannot install it.
 *
 * Every value that names a path — `link:`, `file:`, `portal:`, `workspace:`, a
 * bare `/x` or `E:/x`, and the `name@link:…` form the manager reports as
 * `source` — is refused with a note instead of a spec. Such a value is a
 * statement about the filesystem of the machine that wrote the manifest; pnpm
 * would fail on it here, and naming the reason up front is worth more than a
 * guaranteed failure. A registry range, tag, or alias is composed back into
 * `name@spec` so pnpm saves the spec the manifest already declares.
 * @param {string} name - the declared package name.
 * @param {string | null} spec - the manifest's value, when it has one.
 * @param {unknown} source - the `source` a bundle row reported, when it did.
 * @returns {{ installSpec: string | null, resolvable: boolean, note: string | null }}
 */
export function installSpecFor(name, spec, source) {
  const reported = typeof source === 'string' && source.trim() !== '' ? source.trim() : null
  const recorded = reported ?? (typeof spec === 'string' && spec.trim() !== '' ? spec.trim() : null)
  if (recorded === null) return { installSpec: name, resolvable: true, note: null }
  const note = localNote(recorded)
  if (note !== null) return { installSpec: null, resolvable: false, note }
  // A reported `source` is already a whole `pnpm add` argument; a manifest value
  // is only the version part and needs its package name back.
  if (reported !== null) return { installSpec: recorded, resolvable: true, note: null }
  if (SELF_RESOLVING_RE.test(recorded)) return { installSpec: recorded, resolvable: true, note: null }
  return { installSpec: `${name}@${recorded}`, resolvable: true, note: null }
}

/**
 * Whether the profile's own dependency tree holds the package, as a third piece
 * of evidence beside the two inventory services.
 *
 * `listBundles()` describes bundles and dependencies it can resolve, and omits a
 * dependency that is present but neither selected nor a bundle at all;
 * `listPlugins()` describes the loader's entries and says nothing about a
 * package that is installed but not composed. The disk is where such a package
 * still is, and checking it is what keeps a plain library dependency from being
 * reported as a missing plugin.
 * @param {string} root - the profile directory.
 * @param {string} name - the package name.
 */
function installedOnDisk(root, name) {
  if (!PACKAGE_NAME_RE.test(name)) return false
  return existsSync(join(root, 'node_modules', name, 'package.json'))
}

/**
 * The host's plugin manager, by either access style a Cordis context offers.
 *
 * The service is reached as `ctx.pluginManager`, which is the documented access;
 * `ctx.get('pluginManager')` is the style the rest of this plugin uses for
 * optional services, and a host that publishes one but not the other still has
 * to work. A context whose service lookup throws reports no manager rather than
 * failing the request.
 * @param {unknown} ctx - the host context.
 */
function managerOf(ctx) {
  try {
    const direct = /** @type {{ pluginManager?: unknown }} */ (ctx)?.pluginManager
    if (direct !== null && typeof direct === 'object') return direct
  } catch {
    // A context without the service can throw on property access.
  }
  try {
    const fetched = /** @type {{ get?: (name: string) => unknown }} */ (ctx)?.get?.('pluginManager')
    return fetched !== null && typeof fetched === 'object' ? fetched : null
  } catch {
    return null
  }
}

/**
 * Package names this machine can already see, plus the bundle rows seen on the
 * way (their `source` is the spec an install of that dependency needs).
 * @param {string} root - the profile directory.
 * @param {object} manager - the plugin manager service.
 */
async function presentInventory(root, manager) {
  const names = new Set()
  const bundles = new Map()
  const sources = { plugins: false, bundles: false }
  try {
    const plugins = await manager.listPlugins()
    if (Array.isArray(plugins)) {
      sources.plugins = true
      for (const entry of plugins) {
        const name = packageNameOf(entry?.moduleName)
        if (name !== null) names.add(name)
      }
    }
  } catch {
    // An inventory this host cannot read is not an answer; the caller reports
    // which sources answered instead of pretending the reading succeeded.
  }
  try {
    const rows = await manager.listBundles()
    if (Array.isArray(rows)) {
      sources.bundles = true
      for (const row of rows) {
        const name = typeof row?.name === 'string' ? row.name : null
        if (name === null) continue
        bundles.set(name, row)
        // Anything but `missing` means the package resolves on this machine:
        // the manager reports `missing` only for a name it cannot find at all.
        if (row.availability !== 'missing') names.add(name)
      }
    }
  } catch {
    // Same as above.
  }
  for (const declared of declaredPlugins(root)) {
    if (installedOnDisk(root, declared.name)) names.add(declared.name)
  }
  return { names, bundles, sources }
}

/**
 * What the profile declares and this machine does not have.
 *
 * Two shapes are possible, and they are deliberately different rather than one
 * shape with zeros in it. When the manager answered, the payload carries
 * `installed`, `missing`, and `counts` — a real verdict. When it did not, the
 * payload carries `available: false` and a `reason`, and deliberately carries no
 * `missing` array at all, so a reader that forgets to look at `available` fails
 * loudly instead of showing an empty list as a clean bill of health.
 * @param {unknown} ctx - the host context.
 * @returns {Promise<object>} the `/api/plugins` answer.
 */
export async function pluginInventory(ctx) {
  const checkedAt = new Date().toISOString()
  const root = profileRoot()
  const declared = declaredPlugins(root)
  const manager = managerOf(ctx)
  if (manager === null) {
    return { available: false, reason: 'no-plugin-manager', checkedAt, declared: declared.length }
  }
  const present = await presentInventory(root, manager)
  if (!present.sources.plugins && !present.sources.bundles) {
    return { available: false, reason: 'plugin-manager-error', checkedAt, declared: declared.length }
  }
  const installed = []
  const missing = []
  for (const entry of declared) {
    if (present.names.has(entry.name)) {
      installed.push(entry.name)
      continue
    }
    const row = present.bundles.get(entry.name)
    const spec = installSpecFor(entry.name, entry.spec, row?.source)
    missing.push({
      name: entry.name,
      spec: entry.spec,
      kind: entry.kind,
      installSpec: spec.installSpec,
      resolvable: spec.resolvable,
      note: spec.note,
      version: typeof row?.version === 'string' ? row.version : null,
    })
  }
  return {
    available: true,
    reason: null,
    checkedAt,
    sources: present.sources,
    installed,
    missing,
    counts: {
      declared: declared.length,
      installed: installed.length,
      missing: missing.length,
      installable: missing.filter(entry => entry.resolvable).length,
      unresolved: missing.filter(entry => !entry.resolvable).length,
    },
  }
}

/**
 * One `installBundle` answer as an outcome the page can print.
 *
 * The manager reports what it *did* (`application`) together with a coded error.
 * A refusal of an already-installed package is the second run of this same
 * route, which is not a failure; a build script left unapproved is not a failure
 * either, but the package will not work until it is approved on the plugins
 * page, so the names are carried out rather than swallowed.
 * @param {object} entry - one row of the missing list.
 * @param {unknown} result - the manager's change result.
 */
function outcomeOf(entry, result) {
  const value = /** @type {Record<string, any>} */ (result ?? {})
  const application = typeof value.application === 'string' ? value.application : null
  const code = typeof value.error?.code === 'string' ? value.error.code : null
  const diagnostic = typeof value.error?.diagnostic === 'string' ? value.error.diagnostic : null
  const version = typeof value.version === 'string' ? value.version : null
  const pendingBuilds = Array.isArray(value.pendingBuilds)
    ? value.pendingBuilds.filter(name => typeof name === 'string')
    : []
  const base = { name: entry.name, spec: entry.spec, installSpec: entry.installSpec, version, pendingBuilds }
  if (code === 'already-installed') return { ...base, outcome: 'already-present', application, message: null }
  if (code !== null || application === 'failed' || application === 'cancelled') {
    return { ...base, outcome: 'failed', application, message: diagnostic ?? code ?? application ?? 'failed' }
  }
  return { ...base, outcome: 'installed', application, message: null }
}

/** A zeroed outcome tally. */
function emptyOutcomes() {
  const counts = {}
  for (const outcome of INSTALL_OUTCOMES) counts[outcome] = 0
  return counts
}

/**
 * Install every declared plugin this machine is missing, one spec at a time.
 *
 * Safe to run twice by construction rather than by hope: a name that is already
 * present is skipped before the manager is called at all, and a manager that
 * refuses an installed package answers `already-installed`, which is reported as
 * `already-present` rather than as a failure. Nothing here removes or disables
 * anything — the install calls are the only mutation this module makes.
 *
 * Installs run strictly one after another. Every call takes the profile's
 * `package.json` lock and runs a package manager; issuing them together would
 * only queue behind that lock while making each outcome impossible to attribute
 * to the spec that produced it.
 * @param {unknown} ctx - the host context.
 * @returns {Promise<object>} the `/api/plugins/install` answer.
 */
export async function installMissingPlugins(ctx) {
  const before = await pluginInventory(ctx)
  if (before.available !== true) {
    return { ...before, results: [], outcomeCounts: emptyOutcomes(), restart: false }
  }
  const manager = /** @type {object} */ (managerOf(ctx))
  const results = []
  for (const entry of before.missing) {
    if (entry.installSpec === null) {
      results.push({
        name: entry.name,
        spec: entry.spec,
        installSpec: null,
        outcome: 'skipped',
        application: null,
        version: null,
        message: entry.note,
        pendingBuilds: [],
      })
      continue
    }
    try {
      results.push(outcomeOf(entry, await manager.installBundle(entry.installSpec)))
    } catch (error) {
      results.push({
        name: entry.name,
        spec: entry.spec,
        installSpec: entry.installSpec,
        outcome: 'failed',
        application: null,
        version: null,
        message: messageOf(error),
        pendingBuilds: [],
      })
    }
  }
  const outcomeCounts = emptyOutcomes()
  for (const result of results) outcomeCounts[result.outcome] += 1
  // Re-read rather than assume: an installation that saved its dependency and
  // one that failed to are told apart by what the manager reports now, not by
  // what this run asked for.
  const after = await pluginInventory(ctx)
  return {
    available: after.available,
    reason: after.reason,
    checkedAt: after.checkedAt,
    declared: after.declared,
    ...(after.sources === undefined ? {} : { sources: after.sources }),
    installed: after.installed ?? [],
    missing: after.missing ?? [],
    counts: after.counts ?? null,
    results,
    outcomeCounts,
    restart: results.some(result => result.outcome === 'installed'),
  }
}
