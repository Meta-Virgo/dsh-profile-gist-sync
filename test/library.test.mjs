/**
 * The backup document itself: what it carries, what it refuses, and what a
 * restore would do — all on a throwaway profile built by the harness.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createReport, makeProfile, tempDir, useProfile, backupDocument } from './harness.mjs'

const { check, finish } = createReport('library')
const backup = await import('../lib/backup.js')

const home = tempDir('dpg-library-')
const profile = makeProfile(join(home, 'profiles', 'test'))
useProfile(profile, home)

// ---- what an export carries --------------------------------------------
const document = backup.exportBackup()
const paths = document.files.map(file => file.path)
check('the document declares the shared format and revision',
  document.format === backup.BACKUP_FORMAT && document.version === backup.BACKUP_VERSION,
  `${document.format} v${document.version}`)
check('the manifest travels as an object, other files as text lines',
  typeof document.files.find(file => file.path === 'package.json')?.json === 'object'
  && Array.isArray(document.files.find(file => file.path === 'cordis.yml')?.lines))
check('configuration is carried', ['cordis.yml', 'cordis.patch.yml', '.npmrc', 'pnpm-workspace.yaml', 'data/note.json', 'suppliers/one.js']
  .every(path => paths.includes(path)), paths.join(', '))
check('the credential store is never carried', !paths.includes('data/auths/credentials.sqlite'))
check('dependencies and the lockfile are never carried',
  !paths.some(path => path.startsWith('node_modules/') || path === 'pnpm-lock.yaml'))
check('local usage counters are excluded by default', !paths.includes('data/usage.json'))
check('but travel when asked for', backup.exportBackup({ includeMachine: true }).files.map(file => file.path).includes('data/usage.json'))
check('the exclusions are reported, not silent',
  backup.collectProfileFiles(profile).excluded.some(entry => entry.code === 'credential')
  && backup.collectProfileFiles(profile).excluded.some(entry => entry.code === 'machine-state'))
check('the size helper agrees with the document', backup.backupBytes(document) > 0)

// ---- what a restore accepts and refuses --------------------------------
const validated = backup.validateBackup(document)
check('a document this plugin wrote validates', validated.files.length === document.files.length)
const refuse = (label, value, code) => {
  let error = null
  try {
    backup.validateBackup(value)
  } catch (caught) {
    error = caught
  }
  check(label, error !== null && error.code === code, `${error?.code}: ${error?.message}`)
}
refuse('a foreign format is refused', { ...document, format: 'something-else' }, 'invalid')
refuse('a future revision is refused', { ...document, version: 9.9 }, 'invalid')
refuse('a path escape is refused', backupDocument('test', [{ path: '../outside.txt', lines: ['x'] }]), 'unsafe-path')
refuse('an absolute path is refused', backupDocument('test', [{ path: 'C:/outside.txt', lines: ['x'] }]), 'unsafe-path')
refuse('a dependency path is refused', backupDocument('test', [{ path: 'node_modules/dep/index.js', lines: ['x'] }]), 'unsafe-path')
refuse('a duplicate path is refused',
  backupDocument('test', [{ path: 'a.txt', lines: ['x'] }, { path: 'a.txt', lines: ['y'] }]), 'invalid')
refuse('a document without a manifest is not a profile backup',
  { format: backup.BACKUP_FORMAT, version: backup.BACKUP_VERSION, createdAt: 'x', profile: 'test', files: [{ path: 'a.txt', lines: ['x'] }] },
  'invalid')
const dropped = backup.validateBackup(backupDocument('test', [
  { path: 'data/auths/credentials.sqlite', lines: ['secret'] },
  { path: 'data/blob.bin', lines: ['\u0000binary'] },
]))
check('a credential store inside an incoming document is dropped, not refused',
  dropped.dropped.some(entry => entry.code === 'credential') && !dropped.files.some(file => file.path.includes('credentials')))

// ---- the restore plan ---------------------------------------------------
const incoming = backupDocument('other', [
  { path: 'data/note.json', lines: ['{"hello":"from the cloud"}'] },
  { path: 'data/fresh.json', lines: ['{"new":true}'] },
])
// A manifest from another machine: it adds a dependency and a bundle, and a
// merge must keep this machine's plugin as well.
incoming.files.find(file => file.path === 'package.json').json = {
  name: 'dsh-profile-cloud',
  dependencies: { 'cloud-plugin': '9.9.9' },
  dsh: { profile: { bundles: ['cloud-bundle'] } },
}
const plan = backup.planRestore(incoming)
const status = Object.fromEntries(plan.files.map(file => [file.path, file.status]))
check('a file only the cloud has is an addition', status['data/fresh.json'] === 'add', JSON.stringify(status))
check('a file that differs is an overwrite', status['data/note.json'] === 'overwrite', JSON.stringify(status))
check('the local-only file is left out of the plan', status['cordis.yml'] === undefined, JSON.stringify(status))
check('a manifest that changes is a merge, not a replacement', status['package.json'] === 'merge', JSON.stringify(status))
check('and the plan says which dependency and bundle it adds',
  plan.manifest.dependenciesAdded.includes('cloud-plugin') && plan.manifest.bundlesAdded.includes('cloud-bundle'),
  JSON.stringify(plan.manifest))

// ---- applying and undoing ----------------------------------------------
const before = readFileSync(join(profile, 'data', 'note.json'), 'utf8')
const { report, undoDir } = backup.applyRestore(incoming)
check('the restore reports what it did', report.files.length === plan.files.length, JSON.stringify(report.counts))
check('the cloud content was written', readFileSync(join(profile, 'data', 'note.json'), 'utf8').includes('from the cloud'))
check('the new file appeared', existsSync(join(profile, 'data', 'fresh.json')))
check('the local-only file survived', existsSync(join(profile, 'cordis.yml')))
check('a manifest merge keeps the local plugin', readFileSync(join(profile, 'package.json'), 'utf8').includes('some-plugin'))
check('a manifest merge takes in the cloud plugin too', readFileSync(join(profile, 'package.json'), 'utf8').includes('cloud-plugin'))
check('the changed bytes were snapshotted first', existsSync(undoDir) && backup.undoStatus() !== null)

const undone = backup.undoLastRestore()
check('undo reports the files it reverted', undone.reverted > 0, JSON.stringify(undone))
check('undo restored the previous bytes', readFileSync(join(profile, 'data', 'note.json'), 'utf8') === before)
check('undo removed the added file', !existsSync(join(profile, 'data', 'fresh.json')))
check('and there is nothing left to undo', backup.undoStatus() === null)

// ---- exports the agent tool hands out ----------------------------------
const exported = backup.writeExportFile(document, 'named-export.json')
check('an export file is written inside the profile work directory',
  exported === join(profile, backup.WORK_DIR, 'exports', 'named-export.json') && existsSync(exported), exported)
let escaped = null
try {
  backup.writeExportFile(document, '../escape.json')
} catch (error) {
  escaped = error
}
check('an export name cannot escape the folder', escaped?.code === 'unsafe-path', escaped?.message)
check('the work directory is never part of a backup', !paths.some(path => path.startsWith(backup.WORK_DIR)))
check('a backup read from disk round-trips', backup.readBackupFile(exported).files.length === document.files.length)

// ---- profile resolution, without any environment ------------------------
const single = tempDir('dpg-single-')
makeProfile(join(single, 'profiles', 'only-one'))
delete process.env.DSH_PROFILE_DIR
delete process.env.DSH_PROFILE
process.env.DSH_HOME = single
backup.rememberProfile(null)
check('a lone profile is used when nothing identifies one',
  backup.profileRoot() === join(single, 'profiles', 'only-one') && backup.profileSource() === 'the only profile present',
  `${backup.profileRoot()} (${backup.profileSource()})`)
backup.rememberProfile({ name: 'reported', dir: profile })
check('what the host reports wins over everything else',
  backup.profileRoot() === profile && backup.profileSource() === 'host', backup.profileSource())
backup.rememberProfile({ name: '', dir: 'C:\\no\\such\\directory' })
check('an unusable host report is ignored rather than trusted', backup.profileSource() !== 'host', backup.profileSource())
backup.rememberProfile(null)
process.env.DSH_PROFILE_DIR = join(single, 'no-such-profile')
delete process.env.DSH_HOME
check('an explicitly configured directory is taken as given',
  backup.profileRoot() === join(single, 'no-such-profile'), backup.profileRoot())
let missing = null
try {
  backup.exportBackup()
} catch (error) {
  missing = error
}
check('and a missing one fails loudly', missing?.code === 'no-profile', missing?.message)

process.exit(finish())
