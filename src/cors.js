/**
 * Cors resolution and header writing, shared by the rest endpoints (`src/api.js`) and the
 * server routes (`src/server.js`).
 *
 * Cors headers split by context: `Allow-Origin` / `Allow-Credentials` belong on every response,
 * `Allow-Methods` / `Allow-Headers` / `Max-Age` only on a preflight, `Expose-Headers` only on a
 * real response. The two writers below reflect that split - browsers ignore the headers that
 * don't apply, so sending them anyway would only waste bytes.
 */

import * as array from 'lib0/array'
import * as error from 'lib0/error'
import * as s from 'lib0/schema'
import { $cors } from './types.js'

/**
 * An origin is `scheme://host[:port]` - no path, no trailing slash, no whitespace. A configured
 * origin that carries any of those would silently never match the `Origin` header a browser
 * sends.
 */
const originRegex = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s]+$/
/**
 * A wildcard origin starts its host with `*.` - the suffix therefore always begins at a domain
 * boundary, so `https://*.example.com` can only ever match hosts under `example.com`. At least
 * two labels must follow the star: `https://*.com` would allowlist every .com origin on the
 * internet. (Label counting cannot recognize multi-label public suffixes - `https://*.co.uk` is
 * accepted and just as open, see API.md.) This also structurally rejects a star in the scheme
 * or port.
 */
const wildcardRegex = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\*\.[^/?#*.:\s]+\.[^/?#*\s]+$/
/**
 * Browsers omit the default port from `Origin`, so a configured origin carrying it explicitly
 * would silently never match.
 */
const defaultPortRegex = /^(https:\/\/[^/?#]+:443|http:\/\/[^/?#]+:80)$/i

const corsFields = new Set(Object.keys(s.$$object.cast($cors).shape))

/**
 * @typedef {object} ResolvedCors
 * @property {boolean} ResolvedCors.originAll whether every origin is allowed (`origin: '*'`)
 * @property {Set<string>|null} ResolvedCors.origins lowercased exact allowlist, null when `originAll`
 * @property {Array<{ prefix: string, suffix: string }>|null} ResolvedCors.originPatterns lowercased wildcard entries, split at the `*`
 * @property {boolean} ResolvedCors.credentials
 * @property {boolean} ResolvedCors.trustSameOrigin
 * @property {string|null} ResolvedCors.allowHeaders
 * @property {string|null} ResolvedCors.exposeHeaders
 * @property {string} ResolvedCors.maxAge
 */

/**
 * Resolve `server.cors`, optionally overridden by an endpoint's `cors`, into the values written
 * on responses and preflights. Returns null when cors is disabled - no `Access-Control-*`
 * header is written at all, so browsers block the response while non-browser clients are
 * unaffected. Throws on a configuration browsers would reject or that could never match.
 * Validation runs on the *merged* config: the server baseline is checked once (server.js
 * resolves it without an endpoint override), each endpoint's effective settings here.
 *
 * @param {import('./types.js').CorsConfig|null|undefined} serverCors
 * @param {Partial<import('./types.js').CorsConfig>|null|undefined} endpointCors
 * @return {ResolvedCors|null}
 */
export const resolveCors = (serverCors, endpointCors) => {
  if (endpointCors === null) return null
  // `false` is how other frameworks disable per-route cors - accepting it would silently
  // inherit the full hub config (spreading a primitive or an array over an object contributes
  // no config fields), the opposite of the intent
  if (endpointCors !== undefined && (typeof endpointCors !== 'object' || array.isArray(endpointCors))) {
    throw error.create('invalid cors config: expected an object or null - `cors: null` disables cors on an endpoint')
  }
  /**
   * @type {Partial<import('./types.js').CorsConfig>|null|undefined}
   */
  let cors = serverCors
  if (endpointCors != null) {
    /**
     * @type {any}
     */
    const merged = { ...serverCors }
    for (const field in endpointCors) {
      if (!corsFields.has(field)) throw error.create(`invalid cors config: unknown field "${field}"`)
      const value = /** @type {any} */ (endpointCors)[field]
      // an explicit `undefined` (an unset env var, a conditional spread) behaves like an absent
      // field - spreading it over the server config would clobber the inherited value
      if (value !== undefined) merged[field] = value
    }
    cors = merged
  }
  if (cors == null) return null
  // `server.cors` is covered by the config schema, endpoint overrides are not - the merged
  // result is re-checked against $cors below. Unknown fields need their own loop: $object
  // accepts extra fields, so a typo would otherwise be silently ignored
  for (const field in cors) {
    if (!corsFields.has(field)) throw error.create(`invalid cors config: unknown field "${field}"`)
  }
  if (cors.origin === undefined) {
    throw error.create('invalid cors config: `origin` is required - an endpoint override inherits it from `server.cors` when that is set')
  }
  // targeted checks before the schema, so the shapes other cors middlewares accept fail with an
  // actionable message instead of a schema dump
  if (typeof cors.origin !== 'string' && !array.isArray(cors.origin)) {
    throw error.create('invalid cors config: `origin` must be \'*\', an origin string, or an array of origins - a function, regex, or boolean origin is not supported, the allowlist is fixed at startup (see API.md)')
  }
  if (array.isArray(cors.origin) && cors.origin.some(origin => typeof origin !== 'string')) {
    throw error.create('invalid cors config: every `origin` entry must be an origin string')
  }
  for (const field of ['allowHeaders', 'exposeHeaders']) {
    const value = /** @type {any} */ (cors)[field]
    if (value !== undefined && (!array.isArray(value) || value.some(header => typeof header !== 'string'))) {
      throw error.create(`invalid cors config: \`${field}\` must be an array of header names`)
    }
  }
  // delta-seconds are non-negative integers - anything else parses nowhere, and browsers treat
  // a malformed value as "cache 5 seconds", not "don't cache" (that is maxAge: 0)
  if (cors.maxAge !== undefined && (typeof cors.maxAge !== 'number' || !Number.isInteger(cors.maxAge) || cors.maxAge < 0)) {
    throw error.create('invalid cors config: `maxAge` must be a non-negative integer number of seconds')
  }
  const schemaErr = new s.ValidationError()
  if (!$cors.check(cors, schemaErr)) {
    throw error.create(`invalid cors config: ${schemaErr.toString()}`)
  }
  const originAll = cors.origin === '*'
  // browsers reject "*" together with Access-Control-Allow-Credentials - an endpoint opening
  // itself to "*" under a credentialed hub must set `credentials: false` explicitly
  if (originAll && cors.credentials === true) {
    throw error.create('invalid cors config: `credentials` requires a concrete `origin` - browsers reject "*" together with Access-Control-Allow-Credentials. An endpoint override inherits `credentials` from `server.cors` - set `credentials: false` on the override to open the endpoint to every origin')
  }
  // browsers treat a "*" entry as the literal header name on credentialed requests, so the pair
  // could only ever break exactly the requests it means to allow
  if (cors.credentials === true && (cors.allowHeaders?.includes('*') === true || cors.exposeHeaders?.includes('*') === true)) {
    throw error.create('invalid cors config: a "*" entry in `allowHeaders`/`exposeHeaders` does not work together with `credentials` - list the headers explicitly')
  }
  // the Fetch wildcard never covers `Authorization` - the api authenticates via it, so a bare
  // "*" would fail exactly the authorized requests it means to allow at the preflight
  if (cors.allowHeaders?.includes('*') === true && !cors.allowHeaders.some(header => header.toLowerCase() === 'authorization')) {
    throw error.create('invalid cors config: a "*" in `allowHeaders` never covers `Authorization` - list it alongside: allowHeaders: [\'*\', \'Authorization\']')
  }
  /**
   * @type {Set<string>|null}
   */
  let origins = null
  /**
   * @type {Array<{ prefix: string, suffix: string }>|null}
   */
  let originPatterns = null
  if (!originAll) {
    const list = array.isArray(cors.origin) ? cors.origin : [cors.origin]
    if (list.length === 0) throw error.create('invalid cors config: `origin` allowlist is empty')
    origins = new Set()
    originPatterns = []
    list.forEach(origin => {
      // "null" is the origin of sandboxed iframes and file:// pages - allowing it allows every
      // sandboxed page on the internet
      if (origin === 'null') {
        throw error.create('invalid cors origin "null" - "null" is the origin of every sandboxed iframe and file:// page and cannot be allowlisted. Apps without a real origin (Electron, file://) should strip or replace the `Origin` header instead (see API.md)')
      }
      if (origin === '') {
        throw error.create('invalid cors config: empty origin entry - check the allowlist for a doubled or trailing comma')
      }
      if (origin === '*') {
        throw error.create('invalid cors origin "*" in an allowlist - use origin: \'*\' to allow every origin')
      }
      const star = origin.indexOf('*')
      if (star >= 0) {
        if (!wildcardRegex.test(origin)) {
          throw error.create(`invalid cors origin "${origin}" - a wildcard origin starts its host with "*." followed by at least two labels (https://*.example.com)`)
        }
      } else if (!originRegex.test(origin)) {
        throw error.create(`invalid cors origin "${origin}" - expected scheme://host[:port] without a trailing slash${origin.includes(',') ? '; use an array for several origins' : ''}`)
      }
      if (defaultPortRegex.test(origin)) {
        throw error.create(`invalid cors origin "${origin}" - browsers omit the default port from the Origin header, so this never matches; drop the port`)
      }
      const lower = origin.toLowerCase()
      if (star >= 0) {
        /** @type {Array<{ prefix: string, suffix: string }>} */ (originPatterns).push({ prefix: lower.slice(0, star), suffix: lower.slice(star + 1) })
      } else {
        /** @type {Set<string>} */ (origins).add(lower)
      }
    })
    if (originPatterns.length === 0) originPatterns = null
  }
  return {
    originAll,
    origins,
    originPatterns,
    credentials: cors.credentials === true,
    trustSameOrigin: cors.trustSameOrigin !== false,
    // the built-in api authenticates via `Authorization`, which is never a "simple" header -
    // without it every authorized browser request would fail at the preflight
    allowHeaders: (cors.allowHeaders ?? ['Content-Type', 'Authorization']).join(', ') || null,
    exposeHeaders: (cors.exposeHeaders ?? []).join(', ') || null,
    maxAge: `${cors.maxAge ?? 3600}`
  }
}

/**
 * The `Access-Control-Allow-Origin` value for a request origin, or null when the origin is not
 * allowed. An allowlist echoes the request's origin back - the header holds a single value, so
 * serving several origins is only possible by reflecting the matching one. A wildcard entry
 * matches by suffix: the star must cover at least one character and may span several labels
 * (`https://*.example.com` matches `https://a.b.example.com`) but never the apex, and ports
 * must be spelled out in the pattern.
 *
 * @param {ResolvedCors} cors
 * @param {string} origin `Origin` request header, '' when absent
 */
const allowedOrigin = (cors, origin) => {
  if (cors.originAll) return '*'
  if (origin === '') return null
  const o = origin.toLowerCase()
  const matches = cors.origins?.has(o) === true ||
    cors.originPatterns?.some(({ prefix, suffix }) => o.length > prefix.length + suffix.length && o.startsWith(prefix) && o.endsWith(suffix)) === true
  return matches ? origin : null
}

/**
 * Whether a request from `origin` may proceed. Gates websocket upgrades - browsers do not
 * enforce cors on those - and every rest request: browsers send "simple" requests without a
 * preflight, and cors only ever hides responses (a request's timing stays observable, and it
 * reaches the server carrying the visitor's ambient credentials), so the server checks the
 * origin itself. Cross-origin requests are denied unless the cors config allows the origin -
 * also when cors is not configured at all. A request without an `Origin` header (node clients,
 * server-to-server) is never restricted; the auth plugin gates those. A request whose `Origin`
 * names the request's own `Host` is same-origin and passes unless `trustSameOrigin` is false.
 * The scheme is deliberately not compared - behind a tls-terminating proxy the server sees http
 * while the browser's `Origin` says https. A proxy that rewrites `Host` fails the comparison
 * closed - list the origin explicitly then.
 *
 * @param {ResolvedCors|null} cors
 * @param {string} origin `Origin` request header, '' when absent
 * @param {string} host `Host` request header, '' when absent
 * @param {string} secFetchSite `Sec-Fetch-Site` request header, '' when absent
 */
export const originAllowed = (cors, origin, host, secFetchSite) => {
  if (origin === '') return true
  if (cors != null && allowedOrigin(cors, origin) != null) return true
  if (cors != null && !cors.trustSameOrigin) return false
  // `Sec-Fetch-Site` reports the schemeful relation the scheme-blind comparison below cannot
  // see: a browser saying anything but same-origin here is a page on another scheme or site -
  // an http page targeting the https api passes the host comparison but not this. Behind a
  // tls-terminating proxy an https page on the https host still reports same-origin, and
  // requests without the header (pre-2023 browsers, non-browser clients) fall through to the
  // comparison, like Go's http.CrossOriginProtection
  if (secFetchSite !== '' && secFetchSite !== 'same-origin' && secFetchSite !== 'none') return false
  const schemeEnd = origin.indexOf('://')
  return schemeEnd > 0 && host !== '' && origin.slice(schemeEnd + 3).toLowerCase() === host.toLowerCase()
}

/**
 * @param {ResolvedCors} cors
 * @param {import('uws').HttpResponse} res
 * @param {string} origin
 * @param {Set<string>} [skip]
 */
const writeOrigin = (cors, res, origin, skip) => {
  const allowed = allowedOrigin(cors, origin)
  if (allowed == null) return false
  res.writeHeader('Access-Control-Allow-Origin', allowed)
  if (cors.credentials && skip?.has('access-control-allow-credentials') !== true) res.writeHeader('Access-Control-Allow-Credentials', 'true')
  return true
}

/**
 * Cors headers for a regular response. `skip` holds the lowercased headers a handler's own
 * `Response` already defines: its `Access-Control-Allow-Origin` takes over cors entirely, and
 * any other header it sets is written once - by the handler, not here.
 *
 * @param {ResolvedCors|null} cors
 * @param {import('uws').HttpResponse} res
 * @param {string} origin
 * @param {Set<string>} [skip]
 */
export const writeCorsResponse = (cors, res, origin, skip) => {
  // the origin gate makes every response depend on the request's `Origin` unless every origin
  // is allowed - cors disabled included, where the same url answers 200 same-origin and 403
  // cross-origin. Without `Vary` a shared cache in front of yhub would serve one origin's
  // response to another. Written even when the handler's Response carries its own `Vary` or
  // takes over `Access-Control-Allow-Origin`: several Vary headers legally combine, and the
  // origin-variance signal must never be lost
  if (cors == null || !cors.originAll) res.writeHeader('Vary', 'Origin')
  if (cors == null) return
  if (skip?.has('access-control-allow-origin') === true || !writeOrigin(cors, res, origin, skip)) return
  if (cors.exposeHeaders != null && skip?.has('access-control-expose-headers') !== true) res.writeHeader('Access-Control-Expose-Headers', cors.exposeHeaders)
}

/**
 * Cors headers for a preflight response. `methods` are the methods actually registered on the
 * route, so the preflight never advertises one that isn't there. Returns whether the origin was
 * allowed - a denied preflight carries no `Access-Control-*` header at all, which browsers
 * treat as failure.
 *
 * @param {ResolvedCors|null} cors
 * @param {import('uws').HttpResponse} res
 * @param {string} origin
 * @param {string} methods
 */
export const writeCorsPreflight = (cors, res, origin, methods) => {
  if (cors == null) return false
  if (!cors.originAll) res.writeHeader('Vary', 'Origin')
  if (!writeOrigin(cors, res, origin)) return false
  res.writeHeader('Access-Control-Allow-Methods', methods)
  if (cors.allowHeaders != null) res.writeHeader('Access-Control-Allow-Headers', cors.allowHeaders)
  res.writeHeader('Access-Control-Max-Age', cors.maxAge)
  return true
}
