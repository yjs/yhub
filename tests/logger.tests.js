import * as t from 'lib0/testing'
import { describeUrl } from '../src/logger.js'
import { createPersistence } from '../src/persistence.js'

const password = 'sup3rsecret'

/**
 * @param {t.TestCase} _tc
 */
export const testDescribeUrl = _tc => {
  t.compare(
    describeUrl(`postgres://alice:${password}@db.example.com:5433/keryx?ssl=require`),
    { hostname: 'db.example.com', port: '5433', username: 'alice', database: 'keryx' }
  )
  // the db index lives in the path for redis, same as the database name does for postgres
  t.compare(
    describeUrl(`redis://default:${password}@redis.example.com:6379/2`),
    { hostname: 'redis.example.com', port: '6379', username: 'default', database: '2' }
  )
  // a part the url omits reads as the empty string - no port means the scheme's default
  t.compare(
    describeUrl('postgres://db.example.com/keryx'),
    { hostname: 'db.example.com', port: '', username: '', database: 'keryx' }
  )
  t.compare(
    describeUrl(`postgresql://alice:${password}@[::1]:5432/keryx`),
    { hostname: '[::1]', port: '5432', username: 'alice', database: 'keryx' }
  )
}

/**
 * The point of the helper: whatever the url carries, only the four endpoint fields come out.
 *
 * @param {t.TestCase} _tc
 */
export const testDescribeUrlOmitsPassword = _tc => {
  for (const url of [
    `postgres://alice:${password}@db.example.com:5433/keryx`,
    // an unencoded '@' or ':' in the password still parses - the *last* '@' ends the authority
    `postgres://alice:SEC@${password}@db.example.com:5433/keryx`,
    `postgres://alice:SEC:${password}@db.example.com:5433/keryx`,
    // percent-encoded, which is how a password containing '/', '#' or '?' has to be written
    `postgres://alice:%2F%23%3F${password}@db.example.com:5433/keryx`,
    // a credential in the query string is not one of the four fields either
    `postgres://alice@db.example.com:5433/keryx?sslpassword=${password}`,
    `rediss://default:${password}@redis.example.com:6380`
  ]) {
    t.assert(!JSON.stringify(describeUrl(url)).includes(password))
  }
}

/**
 * `new URL` rejects a malformed url with an ERR_INVALID_URL whose own enumerable `input` holds the
 * offending string. pino's error serializer copies own enumerable properties onto the log record,
 * so letting that error escape would leak the password through the very path added to close the
 * leak. `describeUrl` must replace it.
 *
 * @param {t.TestCase} _tc
 */
export const testDescribeUrlMalformed = _tc => {
  for (const malformed of [
    `redis://u:${password}@:::bad`,
    // an unencoded '/', '#' or '?' in the password makes the url unparseable. postgres.js and
    // node-redis reject these the same way and for the same reason - they call `new URL` too -
    // so nothing that used to connect stops connecting here
    `postgres://u:SEC/${password}@host:5432/db`,
    `postgres://u:SEC#${password}@host:5432/db`,
    `postgres://u:SEC?${password}@host:5432/db`
  ]) {
    t.fails(() => describeUrl(malformed))
    try {
      describeUrl(malformed)
    } catch (err) {
      t.assert(!(/** @type {Error} */ (err).message.includes(password)))
      t.assert(!JSON.stringify({ ...(/** @type {any} */ (err)) }).includes(password))
      t.assert(!(/** @type {Error} */ (err).stack ?? '').includes(password))
    }
  }
}

/**
 * yjs/yhub#70: the connect failure used to name the whole url.
 *
 * Port 1 refuses immediately, so `connect_timeout` never bites and this needs no database.
 *
 * @param {t.TestCase} _tc
 */
export const testPersistenceErrorOmitsPassword = async _tc => {
  try {
    await createPersistence(`postgres://u:${password}@127.0.0.1:1/db`, [])
    t.fail('expected the connection to be refused')
  } catch (err) {
    const message = /** @type {Error} */ (err).message
    t.assert(!message.includes(password))
    // the endpoint is still named, otherwise the error says nothing useful
    t.assert(message.includes('127.0.0.1:1/db'))
  }
}
