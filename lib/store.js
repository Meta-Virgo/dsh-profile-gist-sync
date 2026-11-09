/**
 * What this plugin remembers between visits: which Gist holds the cloud copy,
 * which options were last used, and when the last upload or sync happened.
 *
 * One small file inside the profile's work directory — a hidden directory the
 * exporter never carries, so remembering never feeds back into a backup. Reads
 * are tolerant (a missing or damaged file is simply "nothing remembered yet")
 * and writes are atomic, so a crash mid-write cannot leave a half document that
 * would later be read as settings.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { WORK_DIR, profileRoot } from './backup.js'

const FILE = 'settings.json'

/** The shape a reader can rely on, whatever the file happens to hold. */
function normalize(value) {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const gistId = typeof source.gistId === 'string' && source.gistId.trim() !== '' ? source.gistId.trim() : null
  return {
    gistId,
    includeMachine: source.includeMachine === true,
    lastUpload: objectOrNull(source.lastUpload),
    lastSync: objectOrNull(source.lastSync),
  }
}

/** A record this plugin wrote, or null. */
function objectOrNull(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/** Path of the settings file inside this profile. */
export function settingsPath() {
  return join(profileRoot(), WORK_DIR, FILE)
}

/** Everything remembered here, defaulted. */
export function readSettings() {
  const path = settingsPath()
  if (!existsSync(path)) return normalize(null)
  try {
    return normalize(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    // A damaged file must not take the page down; it just means nothing is known.
    return normalize(null)
  }
}

/**
 * Merge a patch into the remembered settings and write them.
 * @param {object} patch - any of `gistId`, `includeMachine`, `lastUpload`, `lastSync`.
 * @returns {object} the settings as stored.
 */
export function writeSettings(patch) {
  const next = normalize({ ...readSettings(), ...patch })
  const path = settingsPath()
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${String(process.pid)}`
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file is best-effort cleanup around the real failure.
    }
    throw error
  }
  return next
}
