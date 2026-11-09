/**
 * Shared pieces for this plugin's checks.
 *
 * Everything here is deliberately offline and disposable: every profile is a
 * temporary directory built from scratch, and the only network traffic any check
 * produces is what a stub in that check answers. No check reads a real DSH
 * profile, and none of them carries a real Gist id or path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One check, one line of output; failures accumulate instead of throwing. */
export function createReport(name) {
  const state = { failures: 0, passed: 0 }
  const check = (label, ok, detail) => {
    if (ok === true) state.passed += 1
    else state.failures += 1
    const suffix = ok === true || detail === undefined ? '' : ` -- ${detail}`
    console.log(`${ok === true ? 'ok  ' : 'FAIL'} ${label}${suffix}`)
  }
  const finish = () => {
    console.log(state.failures === 0
      ? `\n${name}: ALL CHECKS PASSED (${state.passed})`
      : `\n${name}: ${state.failures} CHECK(S) FAILED, ${state.passed} passed`)
    return state.failures === 0 ? 0 : 1
  }
  return { check, finish, state }
}

/** A temporary directory that is removed when the process exits. */
export function tempDir(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  process.on('exit', () => {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Best effort: a failed cleanup must not change a check's verdict.
    }
  })
  return directory
}

/**
 * A profile with the shape the exporter reads: a manifest, a patch layer, a
 * profile config, npm settings, `data/*.json`, and a `suppliers/` tree — plus a
 * credential store and a binary file, which must be dropped rather than carried.
 */
export function makeProfile(root) {
  mkdirSync(join(root, 'data', 'auths'), { recursive: true })
  mkdirSync(join(root, 'suppliers'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'some-dep'), { recursive: true })
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-test',
    private: true,
    dependencies: { 'some-plugin': '1.2.3' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2)}\n`)
  writeFileSync(join(root, 'cordis.patch.yml'), '- insert:\n    - id: local-row\n      name: some-plugin\n')
  writeFileSync(join(root, 'cordis.yml'), 'plugins:\n  some-plugin: {}\n')
  writeFileSync(join(root, '.npmrc'), 'registry=https://registry.example/\n')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(root, 'data', 'note.json'), '{"hello":"world"}\n')
  writeFileSync(join(root, 'data', 'usage.json'), '{"turns":3}\n')
  writeFileSync(join(root, 'data', 'auths', 'credentials.sqlite'), Buffer.from([0, 1, 2, 3, 0, 255]))
  writeFileSync(join(root, 'suppliers', 'one.js'), 'export const one = 1\n')
  writeFileSync(join(root, 'node_modules', 'some-dep', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  return root
}

/** Point the plugin at a profile without touching the ambient environment. */
export function useProfile(root, home) {
  process.env.DSH_PROFILE_DIR = root
  if (home !== undefined) process.env.DSH_HOME = home
  process.env.DSH_PROFILE = 'test'
}

/** An HTTP request against a route handler, with a JSON body when given. */
export async function callRoute(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    payload = text
  }
  return { status: response.status, payload }
}

/** A backup document v0.2, as this plugin and the plugin market both write it. */
export function backupDocument(profile = 'test', extraFiles = []) {
  return {
    format: 'dsh-profile-backup',
    version: 0.2,
    createdAt: '2026-01-01T00:00:00.000Z',
    profile,
    files: [
      { path: 'package.json', json: { name: 'dsh-profile-test', dsh: { profile: { bundles: [] } } } },
      ...extraFiles,
    ],
  }
}

/**
 * Replace the GitHub HTTP layer with a recording stub.
 *
 * Anything that is not GitHub is either this check's own loopback server (which
 * is passed through) or a host the plugin has no business contacting (which
 * throws) — so a green run is also the plugin's privacy contract: nothing but
 * api.github.com was reached. Returns the call log and a restore function.
 */
export function stubGithub({ gistId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90', document = null } = {}) {
  const calls = []
  const real = globalThis.fetch
  const reply = (status, payload) => new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input)
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) return real(input, init)
    if (!url.startsWith('https://api.github.com/')) {
      throw new Error(`a request went to ${url}; only api.github.com is allowed`)
    }
    const method = (init.method ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    // Header names are case-insensitive on the wire; record them lowercased so a
    // check can look one up without guessing how the caller spelled it.
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]))
    calls.push({ method, path: url.replace('https://api.github.com', ''), body, headers })
    if (method === 'POST' && url.endsWith('/gists')) {
      return reply(201, { id: gistId, html_url: `https://gist.github.com/${gistId}`, updated_at: '2026-01-01T00:00:01Z', files: { 'dsh-profile-backup.json': {} } })
    }
    if (method === 'PATCH' && url.includes('/gists/')) {
      return reply(200, { id: gistId, html_url: `https://gist.github.com/${gistId}`, updated_at: '2026-01-01T00:00:02Z', files: { 'dsh-profile-backup.json': {} } })
    }
    if (method === 'GET' && url.includes('/gists/')) {
      return reply(200, {
        id: gistId,
        html_url: `https://gist.github.com/${gistId}`,
        updated_at: '2026-01-01T00:00:02Z',
        files: { 'dsh-profile-backup.json': { content: JSON.stringify(document ?? backupDocument()) } },
      })
    }
    if (method === 'GET' && url.endsWith('/user')) return reply(200, { login: 'someone' })
    return reply(404, { message: `not stubbed: ${method} ${url}` })
  }
  return { calls, restore: () => { globalThis.fetch = real } }
}

/** The pinned token a stubbed call must carry. */
export const TEST_TOKEN = 'gho_test_token_not_a_real_one'

/** Serve one registered route handler on an ephemeral loopback port. */
export async function serveHandler(handler) {
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  }
}
