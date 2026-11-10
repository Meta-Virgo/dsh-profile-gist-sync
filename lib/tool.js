/**
 * The agent-facing half of the same operations the settings page exposes: one
 * `config_backup` tool whose actions call exactly the functions the HTTP routes
 * call, so the two callers can never disagree about what a restore does.
 *
 * Deliberate limits, so the tool cannot be a sandbox escape:
 * - `export` writes inside this plugin's own directory in the profile.
 * - `restore` reads a file only from inside the DSH home directory; importing an
 *   arbitrary path stays a user action on the settings page.
 */
import {
  applyRestore, backupBytes, collectProfileFiles, exportBackupWithReport, planRestore, profileName, profileRoot,
  profileSource, readBackupFile, undoLastRestore, undoStatus, writeExportFile,
} from './backup.js'
import { createGist, parseGistId, readGist, resolveTokenSource, updateGist } from './gist.js'
import { ConfigSyncError } from './errors.js'
import { readSettings, writeSettings } from './store.js'

/** Actions this tool accepts. */
const ACTIONS = ['status', 'export', 'gist_upload', 'gist_read', 'restore', 'undo']

/** Tool definition handed to the host's tool registry. */
const DEFINITION = {
  name: 'config_backup',
  description: [
    "Upload, download, and restore this DSH profile's configuration — the same backup the Config backup settings page writes.",
    'Actions: status (what a backup would carry), export (write a backup JSON into the DSH home),',
    'gist_upload (back up to a secret GitHub Gist), gist_read (download a backup from a Gist and report what restoring would change),',
    'restore (apply a backup from a Gist or from a file inside the DSH home), undo (revert the last restore).',
    'This profile remembers the Gist it syncs with, so gist_upload, gist_read, and restore use it when gistId is omitted; the first gist_upload without one creates the Gist and remembers it.',
    'Installed plugins and their dependencies are never part of a backup: after a restore that adds plugins, install them from the plugins page and restart DSH.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ACTIONS, description: 'What to do.' },
      gistId: {
        type: 'string',
        description: 'Gist id or gist.github.com link. Omit to use the Gist this profile remembers, or, on the first gist_upload, to create one.',
      },
      path: {
        type: 'string',
        description: 'export: optional file name inside the export folder. restore: a backup file path inside the DSH home directory. Ignored otherwise.',
      },
      token: {
        type: 'string',
        description: 'GitHub token for this call only; never stored. Omit to use DSH_GITHUB_TOKEN/GITHUB_TOKEN or a signed-in gh CLI.',
      },
      includeMachine: {
        type: 'boolean',
        description: "Also carry this machine's local usage counters (data/usage.json). Default false.",
      },
      apply: {
        type: 'boolean',
        description: 'For gist_read and restore: write the changes. Without it they only report the plan.',
      },
    },
    required: ['action'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string', description: 'Human-readable result.' },
      },
      required: ['summary'],
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.summary ?? '') }],
  },
  async execute(args) {
    const action = String(args?.action ?? '')
    if (!ACTIONS.includes(action)) throw new ConfigSyncError(`unknown action: ${action}`, 'invalid')
    const includeMachine = args?.includeMachine === true
    if (action === 'status') return { summary: statusText() }
    if (action === 'export') {
      const { backup } = exportBackupWithReport({ includeMachine })
      const target = writeExportFile(backup, args?.path === undefined ? undefined : String(args.path))
      return { summary: `Wrote ${backup.files.length} files to ${target}. Read it from there; the backup body is not echoed here.` }
    }
    if (action === 'gist_upload') {
      const resolved = await resolveTokenSource(args?.token)
      const { backup, dropped, droppedEntries } = exportBackupWithReport({ includeMachine })
      const content = `${JSON.stringify(backup, null, 2)}\n`
      // No id given means "the cloud copy this profile already uses"; only a
      // profile that has none gets a new Gist.
      const rawId = args?.gistId === undefined ? '' : String(args.gistId).trim()
      const id = rawId === '' ? readSettings().gistId : parseGistId(rawId)
      const ref = id === null
        ? await createGist(resolved.token, content)
        : await updateGist(resolved.token, id, content)
      writeSettings({
        gistId: ref.id,
        lastUpload: { at: new Date().toISOString(), files: backup.files.length, bytes: Buffer.byteLength(content), created: id === null, tokenSource: resolved.source },
      })
      return {
        summary: [
          `${id === null ? 'Created' : 'Updated'} a secret Gist with ${backup.files.length} files (${Buffer.byteLength(content)} bytes).`,
          `id: ${ref.id}`,
          `link: ${ref.htmlUrl}`,
          `token source: ${resolved.source}.`,
          droppedEntries === 0
            ? 'No dependency was left out: everything in the manifest survives the move.'
            : `Left out ${droppedEntries} machine-local ${droppedEntries === 1 ? 'dependency' : 'dependencies'}, so the other machine does not inherit a path from this one: ${dropped.map(entry => `${entry.name} (${entry.spec}${entry.version === null ? '' : `, ${entry.package ?? entry.name}@${entry.version}`})`).join(', ')}. A later restore there keeps whatever it already has for them.`,
          'Note: a secret Gist is unlisted, not private — anyone with the link can read it, so do not post it publicly.',
        ].join('\n'),
      }
    }
    if (action === 'gist_read' || action === 'restore') {
      const rawId = args?.gistId === undefined ? '' : String(args.gistId).trim()
      const rawPath = args?.path === undefined ? '' : String(args.path).trim()
      let backup
      let origin
      if (rawId !== '' || (rawPath === '' && readSettings().gistId !== null)) {
        // An explicit id wins; otherwise the remembered cloud copy is used, so
        // the common case ("sync my configuration") needs no id at all.
        const resolved = await resolveTokenSource(args?.token)
        const target = rawId === '' ? readSettings().gistId : parseGistId(rawId)
        const read = await readGist(resolved.token, target)
        backup = read.backup
        origin = `Gist ${read.ref.id}`
      } else if (rawPath !== '') {
        backup = readBackupFile(rawPath)
        origin = rawPath
      } else {
        throw new ConfigSyncError('gistId or path is required for this action', 'invalid')
      }
      const plan = planRestore(backup)
      if (args?.apply !== true) return { summary: `${planText(plan, origin)}\nNothing was written: pass apply: true to restore.` }
      const { report } = applyRestore(backup)
      return {
        summary: [
          `Restored ${report.restored} files from ${origin}.`,
          `added ${report.counts.add}, overwritten ${report.counts.overwrite}, merged ${report.counts.merge}, unchanged ${report.counts.identical}.`,
          report.dropped.length === 0
            ? 'Nothing in the backup was skipped.'
            : `Skipped, never written here: ${report.dropped.map(entry => `${entry.path} [${entry.code}]`).join(', ')}.`,
          report.manifest === null || (report.manifest.dependenciesAdded.length === 0 && report.manifest.bundlesAdded.length === 0)
            ? 'No new plugins are required by this backup.'
            : `Plugins added by this backup: ${[...report.manifest.dependenciesAdded, ...report.manifest.bundlesAdded].join(', ')} — install them from the plugins page.`,
          `Undo snapshot: ${report.undoDir} (use action "undo" to revert).`,
          'Restart DSH to activate the restored configuration.',
        ].join('\n'),
      }
    }
    const report = undoLastRestore()
    return { summary: `Reverted ${report.reverted} files from the undo snapshot ${report.stamp}. Restart DSH to activate.` }
  },
}

/** Profile summary as text. */
function statusText() {
  const root = profileRoot()
  const { backup, dropped } = exportBackupWithReport({})
  const undo = undoStatus()
  const settings = readSettings()
  return [
    `Profile ${profileName()} at ${root} (found via ${profileSource()}).`,
    `${backup.files.length} files, ${backupBytes(backup)} bytes, ${collectProfileFiles(root).excluded.length} excluded.`,
    dropped.length === 0
      ? 'No machine-local dependency would be left out of an upload.'
      : `An upload would leave out ${dropped.length} machine-local ${dropped.length === 1 ? 'dependency' : 'dependencies'}: ${dropped.map(entry => `${entry.name} (${entry.spec})`).join(', ')}.`,
    settings.gistId === null ? 'No cloud copy yet; gist_upload creates one.' : `Cloud copy: Gist ${settings.gistId}.`,
    settings.lastUpload === null ? 'Never uploaded.' : `Last upload ${settings.lastUpload.at} (${settings.lastUpload.files} files).`,
    settings.lastSync === null ? 'Never synced here.' : `Last sync ${settings.lastSync.at} (${settings.lastSync.files} files).`,
    undo === null ? 'No restore to undo.' : `A restore from ${undo.stamp} can still be undone.`,
    'Plugins are never part of a backup. After a restore, install what the manifest names and restart DSH.',
  ].join('\n')
}

/** Restore plan as text, so the model sees exactly what would change. */
function planText(plan, origin) {
  const lines = [
    `Backup from ${origin}: profile ${plan.sourceProfile}, created ${plan.createdAt}.`,
    `Restoring it would add ${plan.counts.add}, overwrite ${plan.counts.overwrite}, merge ${plan.counts.merge}, and leave ${plan.counts.identical} unchanged.`,
    `Files: ${plan.files.map(file => `${file.path} (${file.status})`).join(', ')}`,
  ]
  if (plan.manifest !== null && plan.manifest.dependenciesAdded.length > 0) {
    lines.push(`Dependencies this backup adds: ${plan.manifest.dependenciesAdded.join(', ')} — they need a plugin install afterwards.`)
  }
  if (plan.dropped.length > 0) {
    lines.push(`Ignored (never written here): ${plan.dropped.map(entry => `${entry.path} [${entry.code}]`).join(', ')}.`)
  }
  if (plan.droppedEntries > 0) lines.push(`${plan.droppedEntries} hidden-directory entries were ignored.`)
  return lines.join('\n')
}

/** Register the tool; the returned disposer unregisters it. */
export function registerTool(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined || tools === null) return () => {}
  return tools.register(DEFINITION)
}
