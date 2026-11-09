/**
 * Activation: what DSH gets when it loads this plugin.
 *
 * The row is loaded once, at DSH start, and everything the plugin does happens
 * through `apply(ctx)` — so the contract matters as much as the behaviour:
 * Cordis fails the whole row with "Invalid effect" when an `ctx.effect` callback
 * returns something that is not a disposer, and a failed row means no routes and
 * no tool. That is checked here, not assumed.
 */
import { join } from 'node:path'
import { createReport, makeProfile, tempDir, useProfile, callRoute, serveHandler } from './harness.mjs'

const { check, finish } = createReport('activation')

const home = tempDir('dpg-activation-')
const profile = makeProfile(join(home, 'profiles', 'test'))
useProfile(profile, home)

const { apply } = await import('../index.js')
const { BASE_PATH } = await import('../lib/routes.js')

/** A host context, with Cordis's effect contract enforced. */
function hostContext({ webServer = true, tools = true, profileContext = null, throwOnProfileContext = false } = {}) {
  const seen = { routes: [], tools: [], effects: [], disposers: [] }
  const ctx = {
    get(name) {
      if (name === 'webServer' && webServer) return { register(route) { seen.routes.push(route); return () => {} } }
      if (name === 'profileContext') {
        if (throwOnProfileContext) throw new Error('this host has no service registry')
        return profileContext
      }
      if (name === 'tools' && tools) return { register(tool) { seen.tools.push(tool); return () => {} } }
      return undefined
    },
    effect(fn, label) {
      const dispose = fn()
      if (typeof dispose !== 'function') throw new Error(`Invalid effect: ${String(label)}`)
      seen.effects.push(label)
      seen.disposers.push(dispose)
      return dispose
    },
  }
  return { ctx, seen }
}

// ---- the happy path -----------------------------------------------------
{
  const { ctx, seen } = hostContext()
  let threw = null
  try {
    apply(ctx)
  } catch (error) {
    threw = error
  }
  check('apply activates without throwing', threw === null, threw?.message)
  check('one prefix route is registered', seen.routes.length === 1 && seen.routes[0].kind === 'prefix', JSON.stringify(seen.routes.map(route => `${route.kind} ${route.path}`)))
  check('the route is the one the page calls', seen.routes[0]?.path === BASE_PATH, seen.routes[0]?.path)
  check('every effect returned a disposer', seen.effects.length === 2, seen.effects.join(', '))
  check('the tool is registered once', seen.tools.length === 1)
  const definition = seen.tools[0]
  check('the tool is the documented one', definition?.name === 'config_backup', definition?.name)
  check('and it offers every action the README lists',
    JSON.stringify(definition?.parameters?.properties?.action?.enum) === JSON.stringify(['status', 'export', 'gist_upload', 'gist_read', 'restore', 'undo']),
    JSON.stringify(definition?.parameters?.properties?.action?.enum))
  check('the disposers can be called', (() => {
    try {
      for (const dispose of seen.disposers) dispose()
      return true
    } catch {
      return false
    }
  })())

  // ---- the status route, on the real handler -----------------------------
  const served = await serveHandler(seen.routes[0].handler)
  const status = await callRoute(served.base, `${BASE_PATH}/api/status`)
  check('the status route answers', status.status === 200 && status.payload.profile === 'test', `${status.status} ${JSON.stringify(status.payload).slice(0, 120)}`)
  check('it reports the profile it is working on', status.payload.root === profile, status.payload.root)
  check('it says which source identified the profile', status.payload.profileSource === 'DSH_PROFILE_DIR', status.payload.profileSource)
  check('it lists the files a backup would carry', status.payload.counts.files > 0 && Array.isArray(status.payload.files))
  check('and it reports the exclusions', status.payload.counts.excluded > 0, JSON.stringify(status.payload.counts))
  check('a fresh profile has no cloud copy', status.payload.cloud.gistId === null && status.payload.cloud.lastUpload === null)
  const unknown = await callRoute(served.base, `${BASE_PATH}/api/nope`)
  check('an unknown subpath answers JSON, not a crash', unknown.status === 404 && unknown.payload.code === 'notfound', JSON.stringify(unknown.payload))
  const outside = await callRoute(served.base, '/somewhere-else/api/status')
  check('a path outside the plugin prefix is refused', outside.status === 404, String(outside.status))
  served.close()
}

// ---- hosts that publish less -------------------------------------------
{
  const { ctx, seen } = hostContext({ profileContext: null })
  let threw = null
  try {
    apply(ctx)
  } catch (error) {
    threw = error
  }
  check('a host that reports no profile facts still activates', threw === null && seen.routes.length === 1, threw?.message)
}
{
  const { ctx, seen } = hostContext({ tools: false })
  let threw = null
  try {
    apply(ctx)
  } catch (error) {
    threw = error
  }
  check('a host without a tools service still activates', threw === null && seen.routes.length === 1 && seen.tools.length === 0, threw?.message)
}
{
  const { ctx, seen } = hostContext({ throwOnProfileContext: true })
  let threw = null
  try {
    apply(ctx)
  } catch (error) {
    threw = error
  }
  check('a host whose profile lookup throws still activates', threw === null && seen.routes.length === 1, threw?.message)
}
{
  const { ctx, seen } = hostContext({ webServer: false })
  check('a host without a web server is left alone', apply(ctx) === undefined && seen.routes.length === 0)
}
{
  const { ctx, seen } = hostContext({ profileContext: { name: 'reported', dir: profile } })
  apply(ctx)
  const backup = await import('../lib/backup.js')
  check('the profile the host reports is the one used',
    backup.profileRoot() === profile && backup.profileSource() === 'host', `${backup.profileRoot()} (${backup.profileSource()})`)
  check('and its name is kept for the document', backup.profileName() === 'reported', backup.profileName())
}

process.exit(finish())
