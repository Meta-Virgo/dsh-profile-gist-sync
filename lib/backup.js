/**
 * Profile configuration backups: reading a profile's text configuration into
 * one portable JSON document, validating such a document, and restoring it.
 *
 * Scope, and why:
 * - Only text configuration is carried. Installed packages (`node_modules`) and
 *   the lockfile are excluded: they are reproducible from `package.json`, and
 *   they are by far the largest thing in a profile.
 * - Binary and credential stores are excluded (a SQLite credential database is
 *   neither portable nor something to put in a Gist). The exclusion is listed
 *   in the export report, never silent.
 * - The document format is byte-compatible with `dsh-profile-backup` v0.2 as
 *   the DSH plugin market writes and validates it, so a backup produced here
 *   imports there and vice versa.
 *
 * Restore is merge-style and reversible:
 * - Files present in the backup are written; files the local profile has and
 *   the backup does not are left alone.
 * - `package.json` is merged (dependencies union, bundle list union) so a
 *   machine that already installed plugins keeps them.
 * - Every overwritten or created path is copied into
 *   `<profile>/.dsh-config-sync/undo/<stamp>/` first, so the import can be
 *   undone.
 */
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { ConfigSyncError } from './errors.js'

/** Identifies the document; shared with the plugin market's backup format. */
export const BACKUP_FORMAT = 'dsh-profile-backup'
/** Format revision this plugin writes and accepts. */
export const BACKUP_VERSION = 0.2
/** Upper bound for one whole-profile backup, matching the market's limit. */
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024
/** GitHub's hard limit for a single Gist file. */
export const GIST_MAX_BYTES = 1024 * 1024
/** The file name a Gist import expects. */
export const BACKUP_FILENAME = 'dsh-profile-backup.json'

const MAX_FILES = 256
const MAX_FILE_BYTES = 512 * 1024
/** Directories that are dependencies or VCS state, never configuration. */
const SKIP_DIRS = new Set(['node_modules', '.git'])
/** Lock state: reproducible, large, and machine-specific by design. */
const SKIP_FILES = new Set(['pnpm-lock.yaml'])
/** This machine's usage counters, not configuration. */
const MACHINE_FILES = new Set(['data/usage.json'])
/** Paths holding credentials that must not travel. */
const CREDENTIAL_FILES = new Set(['data/auths/credentials.sqlite'])
const CREDENTIAL_RE = /(^|\/)(credentials\.sqlite3?|.*\.sqlite3?)$/i
/** This plugin's own working directory (undo snapshots, exports). */
export const WORK_DIR = '.dsh-config-sync'

/**
 * Where this profile lives — the single fact the whole plugin needs.
 *
 * The DSH process does NOT necessarily carry `DSH_PROFILE_DIR`: the desktop
 * host is started as `... dsh-desktop-host/lib/index.js <checkout>
 * <profile dir> ...`, with no profile environment at all (`DSH_*` variables
 * seen by shell tools are injected per call, not inherited here). So the
 * profile is resolved from, in order:
 *
 *   1. what the running host itself reported (`rememberProfile`, set at apply
 *      time from the launcher's `profileContext`);
 *   2. `DSH_PROFILE_DIR`, then `DSH_HOME` + `DSH_PROFILE` (CLI installs);
 *   3. the `<profile dir>` positional argument the desktop host passes;
 *   4. the profile that has this plugin installed — the one running it;
 *   5. the only profile there is.
 *
 * Every source is checked against the filesystem, so a stale or wrong answer
 * cannot be returned silently, and the source that won is reported in
 * `/api/status` (`profileSource`) and by the tool's `status` action.
 */
let reportedProfile = null

/** Remember the profile the running host reported. Called once at apply. */
export function rememberProfile(value) {
  reportedProfile = value
  return value
}

/** The Harness home: `DSH_HOME` when set, else `~/.dsh`. */
export function dshHome() {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') return resolve(home.trim())
  return resolve(join(homedir(), '.dsh'))
}

/** Every profile directory on this machine, newest first. */
function profileDirectories() {
  const root = join(dshHome(), 'profiles')
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => join(root, entry.name))
    .filter(directory => existsSync(join(directory, 'package.json')))
    .map(directory => {
      let at = 0
      try {
        at = statSync(join(directory, 'package.json')).mtimeMs
      } catch {
        at = 0
      }
      return { directory, at }
    })
    .sort((a, b) => b.at - a.at)
    .map(entry => entry.directory)
}

/**
 * A directory that looks like the profile this process was started for.
 *
 * Used for values the process was *not* told to trust — a launcher report can
 * be stale, and the host's argument list mixes the profile with the checkout
 * and runtime directories. An explicit environment value is not checked here:
 * it is an instruction, and a missing one gets the dedicated "the profile
 * directory does not exist" error instead of a silent fallback to some other
 * profile.
 */
function usableProfile(directory) {
  if (typeof directory !== 'string' || directory.trim() === '') return null
  const absolute = resolve(directory.trim())
  return existsSync(join(absolute, 'package.json')) ? absolute : null
}

/** An explicitly configured profile directory, taken as given. */
function configuredProfile(directory) {
  if (typeof directory !== 'string' || directory.trim() === '') return null
  return resolve(directory.trim())
}

/**
 * The full shape of a profile, for arguments that were not meant as one: a
 * manifest AND a patch layer. The desktop host's argument list mixes the
 * checkout, the profile, and runtime directories, and only the profile has
 * both files.
 */
function looksLikeProfile(directory) {
  return usableProfile(directory) !== null && existsSync(join(resolve(directory.trim()), 'cordis.patch.yml'))
}

/** The desktop host's own argument list carries the profile directory. */
function profileFromArgv() {
  for (const argument of process.argv.slice(1)) {
    if (typeof argument !== 'string') continue
    if (!looksLikeProfile(argument)) continue
    return resolve(argument.trim())
  }
  return null
}

/** The profile that has this package installed is the one running it. */
function profileHoldingThisPlugin() {
  // The legacy name is checked too: this package was published as
  // `dsh-config-sync` before 1.0.0, and an install of that name still runs
  // exactly this code from exactly this directory.
  const mine = ['node_modules/dsh-profile-gist-sync', 'node_modules/dsh-config-sync']
  const holders = profileDirectories().filter(directory => mine.some(name => existsSync(join(directory, name))))
  return holders.length === 0 ? null : holders[holders.length - 1]
}

/**
 * Walk the chain and name the source of the answer.
 *
 * Deliberately not cached: a caller may change these variables between calls
 * (the checks do exactly that, to run against a throwaway profile), and the
 * cost of an answer is a handful of `existsSync` calls.
 */
export function resolveProfile() {
  const attempts = []

  const reportedDir = usableProfile(reportedProfile?.dir)
  if (reportedDir !== null) {
    return { dir: reportedDir, name: profileNameOf(reportedProfile?.name, reportedDir), source: 'host' }
  }
  attempts.push('host')

  const explicit = configuredProfile(process.env.DSH_PROFILE_DIR)
  if (explicit !== null) {
    return { dir: explicit, name: profileNameOf(process.env.DSH_PROFILE, explicit), source: 'DSH_PROFILE_DIR' }
  }
  attempts.push('DSH_PROFILE_DIR')

  const home = process.env.DSH_HOME
  const name = process.env.DSH_PROFILE
  if (typeof home === 'string' && home.trim() !== '' && typeof name === 'string' && name.trim() !== '') {
    return { dir: resolve(home.trim(), 'profiles', name.trim()), name: name.trim(), source: 'DSH_HOME/DSH_PROFILE' }
  }
  attempts.push('DSH_HOME/DSH_PROFILE')

  const fromArgv = profileFromArgv()
  if (fromArgv !== null) {
    return { dir: fromArgv, name: profileNameOf(null, fromArgv), source: 'host arguments' }
  }
  attempts.push('host arguments')

  const holder = profileHoldingThisPlugin()
  if (holder !== null) {
    return { dir: holder, name: profileNameOf(null, holder), source: 'profile with this plugin installed' }
  }
  attempts.push('profile with this plugin installed')

  const profiles = profileDirectories()
  if (profiles.length === 1) {
    return { dir: profiles[0], name: profileNameOf(null, profiles[0]), source: 'the only profile present' }
  }
  attempts.push('the only profile present')

  throw new ConfigSyncError(
    `no profile directory found under ${join(dshHome(), 'profiles')} (tried: ${attempts.join(', ')})`,
    'no-profile',
  )
}

/** The profile directory this process works on. */
export function profileRoot() {
  return resolveProfile().dir
}

/** Which source answered, for the status payload and the tool. */
export function profileSource() {
  try {
    return resolveProfile().source
  } catch {
    return 'unresolved'
  }
}

/** A profile's name, preferring what the caller reported. */
function profileNameOf(reported, directory) {
  if (typeof reported === 'string' && reported.trim() !== '') return reported.trim()
  const env = process.env.DSH_PROFILE
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  const parts = resolve(directory).split(/[\\/]/).filter(part => part !== '')
  return parts[parts.length - 1] ?? 'default'
}

/** The profile's name, for the document and the UI. */
export function profileName() {
  try {
    return resolveProfile().name
  } catch {
    return 'default'
  }
}

/** Whether a buffer is text this format can carry losslessly. */
function isText(buffer) {
  if (buffer.includes(0)) return false
  return !buffer.toString('utf8').includes('\uFFFD')
}

/** Excluded-entry codes the client localizes. */
const EXCLUSION_CODES = {
  dependency: 'dependency',
  lockfile: 'lockfile',
  'hidden-dir': 'hidden-dir',
  'backup-copy': 'backup-copy',
  symlink: 'symlink',
  'machine-state': 'machine-state',
  credential: 'credential',
  binary: 'binary',
  'too-large': 'too-large',
  'tool-state': 'tool-state',
}

/**
 * Walk the profile and split its files into what a backup carries and what it
 * deliberately leaves out (with a reason for each omission).
 * @param {string} root - the profile directory.
 * @param {{ includeMachine?: boolean }} [options] - include local usage state.
 * @returns {{ included: Array<{ path: string, bytes: number }>, excluded: Array<{ path: string, code: string }> }}
 */
export function collectProfileFiles(root, options = {}) {
  const includeMachine = options.includeMachine === true
  const included = []
  const excluded = []
  /** @param {string} dir @param {string} prefix */
  const walk = (dir, prefix) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if (prefix === '') throw new ConfigSyncError(`cannot read the profile directory: ${String(error)}`, 'other')
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) {
        excluded.push({ path, code: EXCLUSION_CODES.symlink })
        continue
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          excluded.push({ path, code: EXCLUSION_CODES.dependency })
          continue
        }
        // Plugin caches and state live in hidden directories; walking them
        // would count megabytes of logs as configuration.
        if (entry.name.startsWith('.')) {
          excluded.push({ path, code: EXCLUSION_CODES['hidden-dir'] })
          continue
        }
        walk(join(dir, entry.name), path)
        continue
      }
      if (!entry.isFile()) continue
      if (SKIP_FILES.has(entry.name)) {
        excluded.push({ path, code: EXCLUSION_CODES.lockfile })
        continue
      }
      if (/\.bak\b/i.test(entry.name)) {
        excluded.push({ path, code: EXCLUSION_CODES['backup-copy'] })
        continue
      }
      if (CREDENTIAL_FILES.has(path) || CREDENTIAL_RE.test(path)) {
        excluded.push({ path, code: EXCLUSION_CODES.credential })
        continue
      }
      if (MACHINE_FILES.has(path) && !includeMachine) {
        excluded.push({ path, code: EXCLUSION_CODES['machine-state'] })
        continue
      }
      const absolute = join(dir, entry.name)
      let buffer
      try {
        buffer = readFileSync(absolute)
      } catch {
        excluded.push({ path, code: EXCLUSION_CODES['tool-state'] })
        continue
      }
      if (buffer.byteLength > MAX_FILE_BYTES) {
        excluded.push({ path, code: EXCLUSION_CODES['too-large'] })
        continue
      }
      if (!isText(buffer)) {
        excluded.push({ path, code: EXCLUSION_CODES.binary })
        continue
      }
      included.push({ path, bytes: buffer.byteLength })
      if (included.length > MAX_FILES) {
        throw new ConfigSyncError(
          `this profile has more than ${MAX_FILES} configuration files, which does not fit one backup`,
          'too-large',
        )
      }
    }
  }
  walk(root, '')
  return { included, excluded }
}

/**
 * Serialize the profile's configuration into one backup document.
 * @param {{ includeMachine?: boolean }} [options] - include local usage state.
 * @returns {object} the backup document.
 */
export function exportBackup(options = {}) {
  const root = profileRoot()
  if (!existsSync(root)) {
    throw new ConfigSyncError(`the profile directory does not exist: ${root}`, 'no-profile')
  }
  const { included } = collectProfileFiles(root, options)
  const files = []
  for (const entry of included) {
    const absolute = resolve(root, entry.path)
    const content = readFileSync(absolute, 'utf8')
    if (entry.path === 'package.json') {
      let json
      try {
        json = JSON.parse(content)
      } catch (error) {
        throw new ConfigSyncError(`the profile package.json is not valid JSON: ${String(error)}`, 'invalid')
      }
      files.push({ path: entry.path, json })
    } else {
      files.push({ path: entry.path, lines: content.split(/\r?\n/) })
    }
  }
  if (!files.some(file => file.path === 'package.json')) {
    throw new ConfigSyncError('the profile package.json is missing', 'invalid')
  }
  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    profile: profileName(),
    files,
  }
  const bytes = backupBytes(backup)
  if (bytes > MAX_BACKUP_BYTES) {
    throw new ConfigSyncError(
      `this profile's configuration is ${(bytes / (1024 * 1024)).toFixed(1)} MB, which does not fit one backup`,
      'too-large',
    )
  }
  return backup
}

/** Serialized size of a backup document. */
export function backupBytes(backup) {
  return Buffer.byteLength(JSON.stringify(backup))
}

/** The text a `lines` entry restores to. */
function linesText(lines) {
  return lines.join('\n')
}

/**
 * Why this entry must not be written into the profile, or null when it may be.
 * Answering with a reason instead of throwing keeps a backup written elsewhere
 * importable: a credential store this plugin never exports (the plugin market's
 * exporter does include it) or a cached binary is skipped and reported, while
 * the rest of the configuration still arrives.
 * @param {string[]} parts - the normalized path segments.
 * @param {string | null} text - the file's text, or null for a JSON entry.
 * @param {number} bytes - the serialized size.
 */
function skipReason(parts, text, bytes) {
  if (parts.some((part, index) => part.startsWith('.') && index < parts.length - 1)) {
    return EXCLUSION_CODES['hidden-dir']
  }
  if (parts.some(part => CREDENTIAL_RE.test(part))) return EXCLUSION_CODES.credential
  if (parts.some(part => /\.bak\b/.test(part))) return EXCLUSION_CODES['backup-copy']
  if (bytes > MAX_FILE_BYTES) return EXCLUSION_CODES['too-large']
  if (text !== null && (text.includes('\u0000') || text.includes('\uFFFD'))) return EXCLUSION_CODES.binary
  return null
}

/**
 * Accept only a document this plugin is willing to write into the profile.
 *
 * Hard refusals are the ones that make a document untrustworthy: a path that
 * escapes the profile, a dependency directory, a duplicate path, a malformed
 * entry, or no usable `package.json`. Entries that are merely not configuration
 * this plugin carries — hidden directories, credential stores, backup copies,
 * binaries, oversized files — are dropped with a reason for the caller to show.
 * @param {unknown} value - parsed JSON from a file or a Gist.
 * @returns {object} the validated backup, with `files` normalized and `dropped` listed.
 */
export function validateBackup(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigSyncError('this file is not a DSH profile backup', 'invalid')
  }
  const backup = /** @type {Record<string, unknown>} */ (value)
  if (backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION || !Array.isArray(backup.files)) {
    throw new ConfigSyncError(
      `unsupported backup format: expected ${BACKUP_FORMAT} v${BACKUP_VERSION}`,
      'invalid',
    )
  }
  if (backup.files.length > MAX_FILES) throw new ConfigSyncError('the backup carries too many files', 'invalid')
  const files = []
  const dropped = []
  const seen = new Set()
  for (const raw of backup.files) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ConfigSyncError('the backup carries an invalid file entry', 'invalid')
    }
    const file = /** @type {{ path?: unknown, json?: unknown, lines?: unknown }} */ (raw)
    const path = typeof file.path === 'string' ? file.path.replaceAll('\\', '/') : null
    if (path === null || path === '' || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
      throw new ConfigSyncError(`unsafe backup path: ${String(file.path)}`, 'unsafe-path')
    }
    const parts = path.split('/')
    if (parts.some(part => part === '' || part === '.' || part === '..')) {
      throw new ConfigSyncError(`unsafe backup path: ${path}`, 'unsafe-path')
    }
    if (parts.some(part => SKIP_DIRS.has(part) || SKIP_FILES.has(part))) {
      throw new ConfigSyncError(`excluded backup path: ${path}`, 'unsafe-path')
    }
    if (seen.has(path)) throw new ConfigSyncError(`duplicate backup path: ${path}`, 'invalid')
    seen.add(path)
    // Read the entry before judging it: content that cannot be read at all is a
    // corrupt document, while readable content this plugin does not write is a
    // reported omission.
    let json = null
    let lines = null
    if (path === 'package.json') {
      if (file.json === null || typeof file.json !== 'object' || Array.isArray(file.json)) {
        throw new ConfigSyncError('the backup package.json is invalid', 'invalid')
      }
      json = /** @type {Record<string, unknown>} */ (file.json)
    } else {
      if (!Array.isArray(file.lines) || !file.lines.every(line => typeof line === 'string')) {
        throw new ConfigSyncError(`invalid file content: ${path}`, 'invalid')
      }
      lines = /** @type {string[]} */ (file.lines)
    }
    const text = lines === null ? null : linesText(lines)
    const bytes = text === null ? Buffer.byteLength(JSON.stringify(json)) : Buffer.byteLength(text)
    const reason = skipReason(parts, text, bytes)
    if (reason !== null) {
      dropped.push({ path, code: reason })
      continue
    }
    files.push(json === null ? { path, lines } : { path, json })
  }
  if (!files.some(file => file.path === 'package.json')) {
    throw new ConfigSyncError('the backup has no usable package.json, so it is not a profile backup', 'invalid')
  }
  const total = Buffer.byteLength(JSON.stringify({ ...backup, files }))
  if (total > MAX_BACKUP_BYTES) throw new ConfigSyncError('the backup is too large', 'too-large')
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: typeof backup.createdAt === 'string' ? backup.createdAt : new Date().toISOString(),
    profile: typeof backup.profile === 'string' ? backup.profile : 'unknown',
    files,
    dropped,
    droppedEntries: dropped.length,
  }
}

/** Union of two string lists, keeping `first`'s order and appending new items. */
function union(first, second) {
  const out = []
  for (const value of [...first, ...second]) {
    if (typeof value === 'string' && !out.includes(value)) out.push(value)
  }
  return out
}

/**
 * Merge a backup manifest into the local one: the local machine's plugins and
 * settings survive, and the backup's entries are added.
 * @param {Record<string, unknown>} current - the local package.json.
 * @param {Record<string, unknown>} incoming - the backup's package.json.
 */
function mergeManifest(current, incoming) {
  const merged = { ...current, ...incoming }
  const currentDeps = current.dependencies !== null && typeof current.dependencies === 'object' && !Array.isArray(current.dependencies)
    ? /** @type {Record<string, unknown>} */ (current.dependencies)
    : {}
  const incomingDeps = incoming.dependencies !== null && typeof incoming.dependencies === 'object' && !Array.isArray(incoming.dependencies)
    ? /** @type {Record<string, unknown>} */ (incoming.dependencies)
    : {}
  const added = Object.keys(incomingDeps).filter(name => !(name in currentDeps))
  merged.dependencies = { ...currentDeps, ...incomingDeps }
  const currentDsh = current.dsh !== null && typeof current.dsh === 'object' && !Array.isArray(current.dsh)
    ? /** @type {Record<string, unknown>} */ (current.dsh)
    : {}
  const incomingDsh = incoming.dsh !== null && typeof incoming.dsh === 'object' && !Array.isArray(incoming.dsh)
    ? /** @type {Record<string, unknown>} */ (incoming.dsh)
    : {}
  const currentProfile = currentDsh.profile !== null && typeof currentDsh.profile === 'object' && !Array.isArray(currentDsh.profile)
    ? /** @type {Record<string, unknown>} */ (currentDsh.profile)
    : {}
  const incomingProfile = incomingDsh.profile !== null && typeof incomingDsh.profile === 'object' && !Array.isArray(incomingDsh.profile)
    ? /** @type {Record<string, unknown>} */ (incomingDsh.profile)
    : {}
  const currentBundles = Array.isArray(currentProfile.bundles) ? currentProfile.bundles : []
  const incomingBundles = Array.isArray(incomingProfile.bundles) ? incomingProfile.bundles : []
  const bundles = union(
    currentBundles.filter(name => typeof name === 'string'),
    incomingBundles.filter(name => typeof name === 'string'),
  )
  merged.dsh = {
    ...currentDsh,
    ...incomingDsh,
    profile: { ...currentProfile, ...incomingProfile, bundles },
  }
  return {
    manifest: merged,
    dependenciesAdded: added,
    bundlesAdded: bundles.filter(name => !currentBundles.includes(name)),
  }
}

/**
 * What restoring this backup would do, without writing anything.
 * @param {object} backup - a validated backup.
 */
export function planRestore(backup) {
  const root = profileRoot()
  const entries = []
  let manifest = null
  let total = 0
  for (const file of backup.files) {
    const target = resolve(root, file.path)
    if (!target.startsWith(root + sep)) {
      throw new ConfigSyncError(`unsafe backup path: ${file.path}`, 'unsafe-path')
    }
    const incoming = 'json' in file ? `${JSON.stringify(file.json, null, 2)}\n` : linesText(file.lines)
    const bytes = Buffer.byteLength(incoming)
    total += bytes
    const existing = existsSync(target) ? readFileSync(target) : null
    let status = 'add'
    if (existing !== null) {
      status = existing.toString('utf8') === incoming ? 'identical' : 'overwrite'
    }
    if (file.path === 'package.json' && existing !== null) {
      let current
      try {
        current = JSON.parse(existing.toString('utf8'))
      } catch {
        current = null
      }
      if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
        manifest = mergeManifest(current, file.json)
        // The merged manifest is what a restore would write; when it already
        // matches the file on disk, the restore changes nothing here.
        status = JSON.stringify(manifest.manifest, null, 2) === existing.toString('utf8').trimEnd()
          ? 'identical'
          : 'merge'
      }
    }
    entries.push({ path: file.path, status, bytes })
  }
  return {
    profile: profileName(),
    root,
    createdAt: backup.createdAt,
    sourceProfile: backup.profile,
    files: entries,
    counts: {
      add: entries.filter(entry => entry.status === 'add').length,
      overwrite: entries.filter(entry => entry.status === 'overwrite').length,
      merge: entries.filter(entry => entry.status === 'merge').length,
      identical: entries.filter(entry => entry.status === 'identical').length,
    },
    bytes: total,
    manifest: manifest === null
      ? null
      : { dependenciesAdded: manifest.dependenciesAdded, bundlesAdded: manifest.bundlesAdded },
    dropped: Array.isArray(backup.dropped) ? backup.dropped : [],
    droppedEntries: backup.droppedEntries ?? 0,
    gistFile: BACKUP_FILENAME,
  }
}

/** Directory holding this plugin's own state inside the profile. */
function workRoot() {
  return join(profileRoot(), WORK_DIR)
}

/** Create missing parents one level at a time, refusing symlinks. */
function ensureParent(root, parent, path) {
  if (parent === root) return
  const relative = parent.slice(root.length + 1)
  let current = root
  for (const part of relative.split(sep)) {
    current = join(current, part)
    if (!existsSync(current)) {
      mkdirSync(current)
      continue
    }
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ConfigSyncError(`unsafe backup path: ${path}`, 'unsafe-path')
    }
  }
}

/** Copy one file, creating parent directories. */
function copyInto(source, target) {
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, readFileSync(source))
}

/** Filesystem-safe stamp for an undo snapshot directory. */
function stamp() {
  return new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')
}

/**
 * Restore a backup into the profile, keeping an undo snapshot first.
 * @param {unknown} value - the document (revalidated here, never trusted).
 * @returns {{ report: object, undoDir: string }}
 */
export function applyRestore(value) {
  const backup = validateBackup(value)
  const root = profileRoot()
  const plan = planRestore(backup)
  const undoDir = join(workRoot(), 'undo', stamp())
  const entries = []
  mkdirSync(undoDir, { recursive: true })
  try {
    for (const file of backup.files) {
      const target = resolve(root, file.path)
      if (!target.startsWith(root + sep)) throw new ConfigSyncError(`unsafe backup path: ${file.path}`, 'unsafe-path')
      ensureParent(root, resolve(target, '..'), file.path)
      if (existsSync(target) && !lstatSync(target).isFile()) {
        throw new ConfigSyncError(`backup path is not a file: ${file.path}`, 'unsafe-path')
      }
      const existed = existsSync(target)
      if (existed) copyInto(target, join(undoDir, 'files', file.path))
      let content
      if ('json' in file) {
        if (file.path === 'package.json' && existed) {
          let current = null
          try {
            current = JSON.parse(readFileSync(target, 'utf8'))
          } catch {
            current = null
          }
          content = current !== null && typeof current === 'object' && !Array.isArray(current)
            ? `${JSON.stringify(mergeManifest(current, file.json).manifest, null, 2)}\n`
            : `${JSON.stringify(file.json, null, 2)}\n`
        } else {
          content = `${JSON.stringify(file.json, null, 2)}\n`
        }
      } else {
        content = linesText(file.lines)
      }
      const temporary = `${target}.dsh-config-sync-${String(process.pid)}`
      writeFileSync(temporary, content, 'utf8')
      renameSync(temporary, target)
      entries.push({ path: file.path, existed })
    }
    writeFileSync(
      join(undoDir, 'manifest.json'),
      `${JSON.stringify({ createdAt: new Date().toISOString(), profile: profileName(), entries }, null, 2)}\n`,
      'utf8',
    )
  } catch (error) {
    // Put back whatever this attempt already changed, then report the failure.
    try {
      undoFrom(undoDir)
      rmSync(undoDir, { recursive: true, force: true })
    } catch {
      // Keep the original failure: a failed rollback is reported by the caller.
    }
    throw error
  }
  return {
    report: {
      ...plan,
      restored: entries.length,
      undoDir,
      restart: 'Restart DSH to activate configuration restored here.',
    },
    undoDir,
  }
}

/**
 * Remove directories an undo emptied, deepest first, so reverting an import
 * does not leave a trail of empty folders behind. `rmdirSync` refuses a
 * non-empty directory, which is exactly the stopping condition wanted here.
 */
function pruneEmptyDirs(root, target) {
  let current = dirname(target)
  while (current !== root && current.startsWith(root + sep)) {
    try {
      rmdirSync(current)
    } catch {
      return
    }
    current = dirname(current)
  }
}

/** Revert the changes recorded in one undo snapshot. */
function undoFrom(undoDir) {
  const manifestPath = join(undoDir, 'manifest.json')
  if (!existsSync(manifestPath)) throw new ConfigSyncError('that undo snapshot is incomplete', 'nothing-to-undo')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const root = profileRoot()
  const entries = Array.isArray(manifest.entries) ? manifest.entries : []
  let reverted = 0
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') continue
    const target = resolve(root, entry.path)
    if (!target.startsWith(root + sep)) continue
    if (entry.existed === true) {
      const saved = join(undoDir, 'files', entry.path)
      if (existsSync(saved)) {
        copyInto(saved, target)
        reverted += 1
      }
      continue
    }
    rmSync(target, { force: true })
    pruneEmptyDirs(root, target)
    reverted += 1
  }
  return reverted
}

/** The newest undo snapshot, when one exists. */
export function undoStatus() {
  const dir = join(workRoot(), 'undo')
  if (!existsSync(dir)) return null
  const candidates = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  const latest = candidates[candidates.length - 1]
  if (latest === undefined) return null
  const manifestPath = join(dir, latest, 'manifest.json')
  if (!existsSync(manifestPath)) return { stamp: latest, createdAt: null, files: 0 }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return {
      stamp: latest,
      createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null,
      files: Array.isArray(manifest.entries) ? manifest.entries.length : 0,
    }
  } catch {
    return { stamp: latest, createdAt: null, files: 0 }
  }
}

/** Revert the newest restore and drop its snapshot. */
export function undoLastRestore() {
  const status = undoStatus()
  if (status === null) throw new ConfigSyncError('there is no restore to undo', 'nothing-to-undo')
  const undoDir = join(workRoot(), 'undo', status.stamp)
  const reverted = undoFrom(undoDir)
  rmSync(undoDir, { recursive: true, force: true })
  return { stamp: status.stamp, reverted }
}

/**
 * Write a backup document next to this plugin's state and return its path.
 * The agent tool uses this instead of accepting arbitrary output paths.
 */
export function writeExportFile(backup, fileName) {
  const directory = join(workRoot(), 'exports')
  mkdirSync(directory, { recursive: true })
  const name = fileName ?? `dsh-profile-backup-${stamp()}.json`
  if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) {
    throw new ConfigSyncError(`invalid export file name: ${name}`, 'unsafe-path')
  }
  const target = join(directory, name)
  writeFileSync(target, `${JSON.stringify(backup, null, 2)}\n`, 'utf8')
  return target
}

/** Read a backup document from a path inside the DSH home directory. */
export function readBackupFile(path) {
  const root = dshHome()
  const target = resolve(path)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new ConfigSyncError(
      'the agent tool only reads backups inside the DSH home directory; import other files from the settings page',
      'unsafe-path',
    )
  }
  if (!existsSync(target)) throw new ConfigSyncError(`no such backup file: ${target}`, 'notfound')
  let parsed
  try {
    parsed = JSON.parse(readFileSync(target, 'utf8'))
  } catch (error) {
    throw new ConfigSyncError(`that file is not valid JSON: ${String(error)}`, 'invalid')
  }
  return validateBackup(parsed)
}
