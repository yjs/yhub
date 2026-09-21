import pino from 'pino'
import * as env from 'lib0/environment'

export const logger = pino({ name: 'yhub', level: env.getConf('log-level') || 'info' })

/**
 * Describe a connection url for a log line: the parts that identify the endpoint, never the
 * password. Parsing rather than redacting means only these four fields can ever be emitted.
 *
 * A field the url omits is the empty string (no port = the scheme's default).
 *
 * @param {string} url
 */
export const describeUrl = url => {
  let u
  try {
    u = new URL(url)
  } catch {
    // ERR_INVALID_URL carries the offending string in `err.input`, which pino's error serializer
    // copies onto the log record. Only the fact that it didn't parse is safe to report.
    throw new Error('malformed connection url')
  }
  return { hostname: u.hostname, port: u.port, username: u.username, database: u.pathname.slice(1) }
}
