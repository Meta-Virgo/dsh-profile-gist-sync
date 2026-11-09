/**
 * One error type for every config-sync failure, carrying a machine-readable
 * `code` so the browser half can show a localized message instead of raw
 * Node/DOM error noise.
 */

/** Machine-readable failure codes shared by the Host routes and the client. */
export const ERROR_CODES = [
  'auth',
  'notfound',
  'rate-limit',
  'invalid',
  'too-large',
  'timeout',
  'network',
  'no-profile',
  'no-cloud',
  'unsafe-path',
  'nothing-to-undo',
  'other',
]

/** HTTP status the route answers with for each code. */
const STATUS_BY_CODE = {
  auth: 401,
  notfound: 404,
  'rate-limit': 429,
  invalid: 400,
  'too-large': 413,
  timeout: 504,
  network: 502,
  'no-profile': 500,
  'no-cloud': 400,
  'unsafe-path': 400,
  'nothing-to-undo': 404,
  other: 500,
}

/** A failure with a stable code; `message` stays human-readable. */
export class ConfigSyncError extends Error {
  /**
   * @param {string} message - human-readable reason, safe to show.
   * @param {string} code - one of {@link ERROR_CODES}.
   */
  constructor(message, code = 'other') {
    super(message)
    this.name = 'ConfigSyncError'
    this.code = ERROR_CODES.includes(code) ? code : 'other'
  }
}

/** HTTP status for a thrown value. */
export function statusOf(error) {
  if (error instanceof ConfigSyncError) return STATUS_BY_CODE[error.code] ?? 500
  return 500
}

/** Normalize any thrown value into `{ error, code }` for a JSON response. */
export function describeError(error) {
  if (error instanceof ConfigSyncError) return { error: error.message, code: error.code }
  if (error instanceof Error) return { error: error.message, code: 'other' }
  return { error: String(error), code: 'other' }
}
