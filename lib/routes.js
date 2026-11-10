/**
 * The Host half's HTTP surface.
 *
 * Every route lives under one `prefix` registration on the bare web server, so
 * this plugin adds one route to the deployment rather than seven, and the
 * admission check happens in one place.
 *
 * Admission: the request must pass the host's own gate when the host publishes
 * one (`connection.requestRejection` covers its Host/Origin fence and its
 * browser login), and its Host — when the transport preserves one — must be
 * loopback or an authority the deployment declared. That is the same rule the
 * shipped API fence applies; these routes are exact matches on the bare web
 * server, so they never pass through that fence themselves.
 */
import {
  BACKUP_FILENAME, GIST_MAX_BYTES, MAX_BACKUP_BYTES, WORK_DIR,
  applyRestore, backupBytes, collectProfileFiles, exportBackupWithReport, planRestore,
  profileName, profileRoot, profileSource, readBackupFile, undoLastRestore, undoStatus, validateBackup,
} from './backup.js'
import { createGist, parseGistId, readGist, resolveTokenSource, tokenSourceNames, updateGist, verifyToken } from './gist.js'
import { ConfigSyncError, describeError, statusOf } from './errors.js'
import { installMissingPlugins, pluginInventory } from './plugins.js'
import { readSettings, settingsPath, writeSettings } from './store.js'

/** The one route prefix this plugin owns. */
export const BASE_PATH = '/dsh-profile-gist-sync'
/** Largest request body accepted for an import (a backup plus JSON framing). */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Register this plugin's routes; the returned disposer removes them. */
export function registerRoutes(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || webServer === null) return () => {}
  return webServer.register({
    kind: 'prefix',
    path: BASE_PATH,
    handler: (request, response) => { void handleRequest(ctx, request, response) },
  })
}

/** Write a JSON payload with no-store caching. */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** Read and parse a JSON request body. */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new ConfigSyncError('the request body is too large', 'too-large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ConfigSyncError('the request body is not valid JSON', 'invalid')
  }
}

/**
 * Authorities this deployment serves besides loopback, as the host declared
 * them (`dsh web --trusted-host <name>`, plus the LAN literals it derives).
 */
function trustedHosts(ctx) {
  const connection = ctx.get('connection')
  const hosts = connection?.trustedHosts
  return Array.isArray(hosts) ? hosts.filter(host => typeof host === 'string') : []
}

/**
 * The Host/Origin rule for these routes: the request's Host must be loopback or
 * a declared authority, the fetch metadata must not say `cross-site`, and an
 * Origin, when present, must match that Host.
 */
function sameOrigin(ctx, request) {
  const host = typeof request.headers.host === 'string' ? request.headers.host : undefined
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined
  const site = typeof request.headers['sec-fetch-site'] === 'string' ? request.headers['sec-fetch-site'] : undefined
  if (site === 'cross-site') return false
  // A non-browser client can set any Origin it likes, so an absent Origin is not
  // itself a refusal; the Host check is what a rebinding attacker cannot forge.
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  if (host === undefined) return true
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (bare === 'localhost' || bare === '127.0.0.1' || bare === '::1' || bare.endsWith('.localhost')) return true
  return trustedHosts(ctx).includes(hostname) || trustedHosts(ctx).includes(bare)
}

/**
 * Answer the request with the host's rejection if it has one.
 * @returns true when the request was refused and answered here.
 */
function refuseUnadmitted(ctx, request, response) {
  const connection = ctx.get('connection')
  const gate = connection?.requestRejection
  if (typeof gate === 'function') {
    let status
    try {
      status = gate.call(connection, request)
    } catch {
      // A gate that throws has not admitted anything.
      status = 403
    }
    if (typeof status === 'number') {
      sendJson(response, status, {
        error: 'DSH refused this request: not signed in, or an untrusted origin',
        code: 'auth',
      })
      return true
    }
  }
  if (!sameOrigin(ctx, request)) {
    sendJson(response, 403, {
      error: 'refused: the Host or Origin of this request is not one this deployment serves',
      code: 'auth',
    })
    return true
  }
  return false
}

/** Profile summary for the settings page. */
function statusPayload() {
  const root = profileRoot()
  const { included, excluded } = collectProfileFiles(root)
  let bytes = 0
  for (const file of included) bytes += file.bytes
  const settings = readSettings()
  return {
    profile: profileName(),
    root,
    profileSource: profileSource(),
    workDir: `${root}\\${WORK_DIR}`,
    version: '1.0.0',
    files: included,
    excluded,
    counts: {
      files: included.length,
      bytes,
      excluded: excluded.length,
      machineFiles: excluded.filter(entry => entry.code === 'machine-state').length,
    },
    limits: { maxBackupBytes: MAX_BACKUP_BYTES, gistMaxBytes: GIST_MAX_BYTES },
    gistFile: BACKUP_FILENAME,
    envTokens: tokenSourceNames(),
    undo: undoStatus(),
    // What this plugin remembers, so the page can show one plain sentence about
    // the cloud copy without asking the reader for anything.
    cloud: {
      gistId: settings.gistId,
      includeMachine: settings.includeMachine,
      lastUpload: settings.lastUpload,
      lastSync: settings.lastSync,
      settingsFile: settingsPath(),
    },
  }
}

/**
 * Which Gist this request is about: the one it names, else the remembered one,
 * else nothing (which means "create a new one" on upload and is a refusal on
 * read).
 * @param {unknown} named - the value from the request body.
 */
function targetId(named) {
  const raw = typeof named === 'string' ? named.trim() : ''
  if (raw !== '') return parseGistId(raw)
  return readSettings().gistId
}

/** Now, in the timestamp shape every record here uses. */
function now() {
  return new Date().toISOString()
}

/**
 * Serve a fresh backup as a download.
 *
 * A file download has nowhere to put the export report, so it is discarded here.
 * The export itself still drops machine-local dependency specs — the alternative
 * would be a file that breaks `pnpm install` wherever it is restored — and the
 * same report is surfaced by the upload response and by the page.
 */
function exportDownload(response, url) {
  const { backup } = exportBackupWithReport({ includeMachine: url.searchParams.get('include') === 'machine' })
  const body = `${JSON.stringify(backup, null, 2)}\n`
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="dsh-profile-backup-${stamp}.json"`,
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** Route one request. Unknown subpaths answer 404 with the same JSON shape. */
async function handleRequest(ctx, request, response) {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(`${BASE_PATH}/`)) {
      sendJson(response, 404, { error: 'not found', code: 'notfound' })
      return
    }
    if (refuseUnadmitted(ctx, request, response)) return
    const route = url.pathname.slice(BASE_PATH.length)
    const method = request.method ?? 'GET'

    if (route === '/api/status' && method === 'GET') {
      sendJson(response, 200, statusPayload())
      return
    }
    if (route === '/api/export' && method === 'GET') {
      exportDownload(response, url)
      return
    }
    if (route === '/api/plugins' && method === 'GET') {
      // Read-only, and deliberately a route of its own: it consults the host's
      // plugin manager, which a status refresh has no business doing.
      sendJson(response, 200, await pluginInventory(ctx))
      return
    }
    if (route === '/api/plugins/install' && method === 'POST') {
      // No confirmation flag: this route only ever adds, the set it installs is
      // the one the previous answer named, and running it twice is a no-op.
      sendJson(response, 200, await installMissingPlugins(ctx))
      return
    }
    if (route === '/api/preview' && method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 200, { preview: planRestore(validateBackup(body?.backup)) })
      return
    }
    if (route === '/api/restore' && method === 'POST') {
      const body = await readJsonBody(request)
      if (body?.confirm !== true) {
        throw new ConfigSyncError('restoring requires an explicit confirmation', 'invalid')
      }
      const { report } = applyRestore(body?.backup)
      sendJson(response, 200, { report })
      return
    }
    if (route === '/api/undo' && method === 'POST') {
      sendJson(response, 200, { report: undoLastRestore() })
      return
    }
    if (route === '/api/file/read' && method === 'POST') {
      const body = await readJsonBody(request)
      const backup = readBackupFile(String(body?.path ?? ''))
      sendJson(response, 200, { backup, preview: planRestore(backup) })
      return
    }
    if (route === '/api/settings' && method === 'POST') {
      const body = await readJsonBody(request)
      const patch = {}
      if (body?.gistId !== undefined) {
        // An empty value clears the remembered cloud copy, which is how the page
        // starts over with a different Gist.
        const raw = typeof body.gistId === 'string' ? body.gistId.trim() : ''
        patch.gistId = raw === '' ? null : parseGistId(raw)
      }
      if (body?.includeMachine !== undefined) patch.includeMachine = body.includeMachine === true
      const stored = writeSettings(patch)
      sendJson(response, 200, {
        cloud: {
          gistId: stored.gistId,
          includeMachine: stored.includeMachine,
          lastUpload: stored.lastUpload,
          lastSync: stored.lastSync,
          settingsFile: settingsPath(),
        },
      })
      return
    }
    if (route === '/api/gist/token' && method === 'POST') {
      const body = await readJsonBody(request)
      const resolved = await resolveTokenSource(body?.token)
      const login = await verifyToken(resolved.token).catch(() => null)
      sendJson(response, 200, { source: resolved.source, login })
      return
    }
    if (route === '/api/gist/upload' && method === 'POST') {
      const body = await readJsonBody(request)
      const resolved = await resolveTokenSource(body?.token)
      const { backup, dropped, droppedEntries } = exportBackupWithReport({ includeMachine: body?.includeMachine === true })
      const content = `${JSON.stringify(backup, null, 2)}\n`
      const id = targetId(body?.id)
      const ref = id === null
        ? await createGist(resolved.token, content)
        : await updateGist(resolved.token, id, content)
      // Remember where the cloud copy lives and when it was written, so the next
      // upload, the sync button, and the status line need no typing.
      writeSettings({
        gistId: ref.id,
        lastUpload: {
          at: now(),
          files: backup.files.length,
          bytes: Buffer.byteLength(content),
          created: id === null,
          tokenSource: resolved.source,
        },
      })
      sendJson(response, 200, {
        ref,
        created: id === null,
        tokenSource: resolved.source,
        bytes: Buffer.byteLength(content),
        files: backup.files.length,
        createdAt: backup.createdAt,
        backupBytes: backupBytes(backup),
        // Machine-local dependency specs left out of what was uploaded, so the
        // page can say so instead of the user finding out on the other machine.
        dropped,
        droppedEntries,
      })
      return
    }
    if (route === '/api/gist/read' && method === 'POST') {
      const body = await readJsonBody(request)
      const resolved = await resolveTokenSource(body?.token)
      const id = targetId(body?.id)
      if (id === null) throw new ConfigSyncError('no cloud backup is set up yet', 'no-cloud')
      const { ref, backup } = await readGist(resolved.token, id)
      sendJson(response, 200, { ref, backup, preview: planRestore(backup), tokenSource: resolved.source })
      return
    }
    if (route === '/api/sync' && method === 'POST') {
      // One call for the whole job: read the cloud copy, then write it here with
      // an undo snapshot taken first.
      const body = await readJsonBody(request)
      const resolved = await resolveTokenSource(body?.token)
      const id = targetId(body?.id)
      if (id === null) {
        throw new ConfigSyncError('there is no cloud backup yet: upload this machine first', 'no-cloud')
      }
      const { ref, backup } = await readGist(resolved.token, id)
      const { report, undoDir: snapshot } = applyRestore(backup)
      writeSettings({
        gistId: ref.id,
        lastSync: {
          at: now(),
          files: report.restored,
          counts: report.counts,
          source: 'gist',
          remoteUpdatedAt: ref.updatedAt ?? null,
        },
      })
      sendJson(response, 200, { ref, report, tokenSource: resolved.source, undoDir: snapshot })
      return
    }
    sendJson(response, 404, { error: `no such route: ${route}`, code: 'notfound' })
  } catch (error) {
    sendJson(response, statusOf(error), describeError(error))
  }
}
