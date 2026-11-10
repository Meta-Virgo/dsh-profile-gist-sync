/**
 * GitHub Gist transport for profile backups.
 *
 * Security posture:
 * - The API host is hard-coded to api.github.com, so there is no SSRF surface.
 * - A Gist id (or a gist.github.com URL) is validated against a strict
 *   character allowlist before it is interpolated into the request path.
 * - Tokens are never written to disk by this plugin. The browser may send one
 *   per request (session memory only); otherwise the host reads
 *   `DSH_GITHUB_TOKEN` / `GITHUB_TOKEN`, or asks an already-signed-in `gh` CLI
 *   for its token.
 * - Content read from a Gist goes through `validateBackup` before anything is
 *   written into the profile.
 *
 * Note the honest limit of a Gist: GitHub has no private Gist. A "secret" Gist
 * is unlisted, not unreadable — anyone holding the link can read it.
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BACKUP_FILENAME, GIST_MAX_BYTES, validateBackup } from './backup.js'
import { ConfigSyncError } from './errors.js'

const API_ORIGIN = 'https://api.github.com'
const GIST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const REQUEST_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = GIST_MAX_BYTES + 64 * 1024
const TOKEN_ENV_NAMES = ['DSH_GITHUB_TOKEN', 'GITHUB_TOKEN']
const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED', 'UND_ERR_SOCKET',
])

/**
 * Normalize a Gist id or gist.github.com URL to a bare id.
 * @param {string} input - the raw user input.
 * @returns {string} the validated id.
 */
export function parseGistId(input) {
  const trimmed = String(input ?? '').trim()
  if (trimmed === '') throw new ConfigSyncError('a Gist id or link is required', 'invalid')
  let candidate = trimmed
  try {
    const url = new URL(trimmed)
    if (url.protocol === 'https:' && (url.hostname === 'gist.github.com' || url.hostname.endsWith('.gist.github.com'))) {
      const parts = url.pathname.split('/').filter(Boolean)
      candidate = parts[parts.length - 1] ?? ''
    }
  } catch {
    // Not a URL: the allowlist below decides.
  }
  if (!GIST_ID_RE.test(candidate)) {
    throw new ConfigSyncError(`not a Gist id or link: ${trimmed}`, 'invalid')
  }
  return candidate
}

/** Which token source answered, so the UI can say where it came from. */
export function tokenSourceNames() {
  const found = []
  for (const name of TOKEN_ENV_NAMES) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') found.push(name)
  }
  return found
}

/**
 * Resolve the token for one request: an explicitly supplied one, then the
 * host's environment, then an already-signed-in `gh` CLI.
 *
 * The failure is the first thing a new machine hits, so it carries the three
 * ways out and the scope the token needs, in that order. Vague wording here
 * ("auth failed") sends the reader to the GitHub docs without telling them which
 * of the three sources to fix.
 * @param {unknown} bodyToken - token supplied with the request, if any.
 * @returns {Promise<{ token: string, source: 'request' | 'env' | 'gh' }>}
 */
export async function resolveTokenSource(bodyToken) {
  if (typeof bodyToken === 'string' && bodyToken.trim() !== '') {
    return { token: bodyToken.trim(), source: 'request' }
  }
  for (const name of TOKEN_ENV_NAMES) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return { token: value.trim(), source: 'env' }
  }
  const fromGh = await ghAuthToken()
  if (fromGh !== null) return { token: fromGh, source: 'gh' }
  throw new ConfigSyncError(`No GitHub token is available.\n${TOKEN_HELP}`, 'auth')
}

let ghTokenCache = null

/** Ask an already-authenticated GitHub CLI for its token, if it has one. */
async function ghAuthToken() {
  if (ghTokenCache !== null && Date.now() < ghTokenCache.expires) return ghTokenCache.token
  const token = await runGhAuthToken()
  ghTokenCache = { token, expires: Date.now() + (token !== null ? 10 * 60_000 : 30_000) }
  return token
}

/**
 * Run `gh auth token` in a detached child and give up after 8 s. The parent
 * never waits on the child, so a wedged gh cannot block the host's event loop.
 * @returns {Promise<string | null>}
 */
function runGhAuthToken() {
  return new Promise((resolveToken) => {
    const candidates = ['gh', join(homedir(), '.local', 'bin', 'gh')]
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolveToken(value)
    }
    const tryNext = (index) => {
      if (index >= candidates.length) {
        finish(null)
        return
      }
      let child = null
      try {
        child = spawn(candidates[index], ['auth', 'token'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          detached: true,
          windowsHide: true,
        })
      } catch {
        tryNext(index + 1)
        return
      }
      if (child == null) {
        tryNext(index + 1)
        return
      }
      let out = ''
      child.stdout?.on('data', (chunk) => { out += chunk.toString() })
      const timer = setTimeout(() => {
        try { child?.kill('SIGKILL') } catch { /* already gone */ }
        finish(out.trim() !== '' ? out.trim() : null)
      }, 8_000)
      let errored = false
      child.on('error', () => {
        if (errored) return
        errored = true
        clearTimeout(timer)
        if (!settled) tryNext(index + 1)
      })
      child.on('close', () => {
        if (errored) return
        clearTimeout(timer)
        finish(out.trim() !== '' ? out.trim() : null)
      })
      child.unref()
    }
    tryNext(0)
  })
}

/** Map a transport-level failure (abort or network error) to a coded error. */
function classifyRequestError(error) {
  if (error instanceof ConfigSyncError) return error
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new ConfigSyncError('the GitHub request timed out', 'timeout')
  }
  const code = error?.code ?? error?.cause?.code
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) {
    return new ConfigSyncError(`GitHub is unreachable (${code})`, 'network')
  }
  return new ConfigSyncError(error instanceof Error ? error.message : String(error), 'network')
}

/** One GitHub API call. */
async function githubRequest(token, method, path, body, signal) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-profile-gist-sync',
    'x-github-api-version': '2022-11-28',
  }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const ceiling = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const effective = signal === undefined
    ? ceiling
    : typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, ceiling]) : signal
  let response
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      method,
      headers,
      body,
      signal: effective,
      redirect: 'error',
    })
  } catch (error) {
    throw classifyRequestError(error)
  }
  const text = await response.text().catch(() => '')
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new ConfigSyncError('the GitHub response is too large', 'invalid')
  }
  return { status: response.status, ok: response.ok, text }
}

/**
 * How to get a token that can reach a Gist, in the three ways this plugin
 * resolves one. Kept in the error itself rather than only in the page's locale
 * dictionary, because the agent tool and any other caller of this module see the
 * same text and neither of them has the page's UI copy.
 */
const TOKEN_HELP = [
  'GitHub needs a token this plugin can use, and none of the three sources answered:',
  '  1. paste one into 高级设置 → GitHub 令牌 on this page (used for that request only, never saved);',
  '  2. set DSH_GITHUB_TOKEN (or GITHUB_TOKEN) in the environment DSH starts with, then restart DSH;',
  '  3. sign in once with the GitHub CLI — `gh auth login` — and this plugin reads `gh auth token`.',
  'The token needs the `gist` scope: GitHub → Settings → Developer settings →',
  'Personal access tokens → Tokens (classic) → Generate new token → tick `gist`.',
  'See: https://github.com/settings/tokens/new?scopes=gist&description=DSH%20config%20sync',
].join('\n')

/**
 * Turn a non-2xx GitHub answer into a coded error.
 *
 * A 401 is not only "bad token": it is equally the answer a valid token gets for
 * a secret Gist belonging to a different account, because GitHub refuses to
 * admit that the Gist exists. The message therefore names all three ways to
 * supply a token and the scope it needs, instead of echoing what is usually a
 * library string nobody can act on.
 */
function parseGithubError(status, text, action) {
  let message = text
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.message === 'string' && parsed.message !== '') message = parsed.message
  } catch {
    // Keep the raw body.
  }
  if (status === 401) {
    return new ConfigSyncError(`GitHub rejected this token for the ${action}: invalid, expired, or not the account that owns the Gist.\n${TOKEN_HELP}`, 'auth')
  }
  if (status === 403) return new ConfigSyncError(`GitHub refused the ${action} (rate limit or missing scope): ${message}\n${TOKEN_HELP}`, 'rate-limit')
  if (status === 404) {
    return new ConfigSyncError(
      `Gist not found — check the id or link, and check that the token belongs to the account that owns it: a secret Gist is only visible to its owner.\n${TOKEN_HELP}`,
      'notfound',
    )
  }
  if (status === 422) return new ConfigSyncError(`GitHub rejected the ${action}: ${message}`, 'invalid')
  return new ConfigSyncError(`GitHub ${action} failed: HTTP ${status} ${message}`, 'other')
}

/** Create a new secret Gist carrying one backup file. */
export async function createGist(token, content, signal) {
  if (Buffer.byteLength(content) > GIST_MAX_BYTES) {
    throw new ConfigSyncError(
      `this backup is ${(Buffer.byteLength(content) / 1024).toFixed(0)} KB, over GitHub's 1 MB per-file limit`,
      'too-large',
    )
  }
  const body = JSON.stringify({
    description: 'DSH profile configuration backup (dsh-profile-gist-sync)',
    public: false,
    files: { [BACKUP_FILENAME]: { content } },
  })
  const response = await githubRequest(token, 'POST', '/gists', body, signal)
  if (response.status !== 201) throw parseGithubError(response.status, response.text, 'Gist creation')
  return gistRef(response.text)
}

/** Overwrite the backup file inside an existing Gist, keeping its other files. */
export async function updateGist(token, gistId, content, signal) {
  if (Buffer.byteLength(content) > GIST_MAX_BYTES) {
    throw new ConfigSyncError(
      `this backup is ${(Buffer.byteLength(content) / 1024).toFixed(0)} KB, over GitHub's 1 MB per-file limit`,
      'too-large',
    )
  }
  const body = JSON.stringify({ files: { [BACKUP_FILENAME]: { content } } })
  const response = await githubRequest(token, 'PATCH', `/gists/${gistId}`, body, signal)
  if (response.status !== 200) throw parseGithubError(response.status, response.text, 'Gist update')
  return gistRef(response.text)
}

/** Read one Gist's fields. */
function gistRef(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new ConfigSyncError('GitHub returned an unreadable Gist payload', 'invalid')
  }
  const id = typeof data?.id === 'string' && data.id !== '' ? data.id : null
  if (id === null) throw new ConfigSyncError('GitHub returned an invalid Gist', 'invalid')
  return {
    id,
    htmlUrl: typeof data?.html_url === 'string' ? data.html_url : `https://gist.github.com/${id}`,
    updatedAt: typeof data?.updated_at === 'string' ? data.updated_at : null,
    files: data?.files !== null && typeof data?.files === 'object' && !Array.isArray(data.files)
      ? Object.keys(data.files)
      : [],
  }
}

/**
 * Download and strictly validate the backup file inside a Gist.
 * @returns {Promise<{ ref: object, backup: object }>}
 */
export async function readGist(token, gistId, signal) {
  const response = await githubRequest(token, 'GET', `/gists/${gistId}`, undefined, signal)
  if (response.status !== 200) throw parseGithubError(response.status, response.text, 'Gist read')
  let data
  try {
    data = JSON.parse(response.text)
  } catch {
    throw new ConfigSyncError('GitHub returned an unreadable Gist payload', 'invalid')
  }
  const file = data?.files?.[BACKUP_FILENAME]
  const content = file !== null && typeof file === 'object' && !Array.isArray(file) ? file.content : undefined
  if (typeof content !== 'string') {
    const names = data?.files !== null && typeof data?.files === 'object' ? Object.keys(data.files) : []
    throw new ConfigSyncError(
      `that Gist has no ${BACKUP_FILENAME} file (it holds: ${names.join(', ') || 'nothing'})`,
      'invalid',
    )
  }
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new ConfigSyncError('the Gist backup is not valid JSON', 'invalid')
  }
  return { ref: gistRef(response.text), backup: validateBackup(parsed) }
}

/** Confirm a token is usable, and report which account it belongs to. */
export async function verifyToken(token, signal) {
  const response = await githubRequest(token, 'GET', '/user', undefined, signal)
  if (response.status !== 200) throw parseGithubError(response.status, response.text, 'token check')
  try {
    const data = JSON.parse(response.text)
    return typeof data?.login === 'string' ? data.login : null
  } catch {
    return null
  }
}
