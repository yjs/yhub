import * as buffer from 'lib0/buffer'
import * as error from 'lib0/error'
import * as promise from 'lib0/promise'
import * as s from 'lib0/schema'
import * as string from 'lib0/string'
import * as perm from './permissions.js'
import * as t from './types.js'
import { builtinApi } from './builtin-api.js'
import { originAllowed, resolveCors, writeCorsPreflight, writeCorsResponse } from './cors.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'api' })

/**
 * `JSON.stringify` replacer producing the json representation of any-encodable values: binary
 * data as base64, `Date` as epoch millis, `undefined` as `null` (preserving the key). A
 * `function`, not an arrow - `this` is the containing object, so `raw` sees values before their
 * `toJSON` runs (`Buffer` and `Date` would otherwise already be converted).
 *
 * @this {any}
 * @param {string} key
 * @param {any} value
 */
const jsonReplacer = function (key, value) {
  const raw = this[key]
  if (raw instanceof Uint8Array) return buffer.toBase64(raw)
  if (raw instanceof Date) return raw.getTime()
  if (raw === undefined) return null // preserve the key
  return value
}

/**
 * @param {import('uws').HttpResponse} res
 * @param {(res: import('uws').HttpResponse, skip?: Set<string>) => void} writeHeaders
 * @param {string} status
 * @param {{ [key: string]: any, error: string }} body
 * @param {boolean} [acceptsJson]
 */
const sendErrorResponse = (res, writeHeaders, status, body, acceptsJson = false) => {
  const response = acceptsJson ? JSON.stringify(body, jsonReplacer) : buffer.encodeAny(body)
  res.cork(() => {
    // the status must be written before any header - otherwise uws locks the status to "200 OK"
    res.writeStatus(status)
    writeHeaders(res)
    res.writeHeader('Content-Type', acceptsJson ? 'application/json' : 'application/x-lib0any')
    res.end(response)
  })
}

/**
 * Map http status codes to the full status lines that uws' `writeStatus` expects.
 *
 * @type {{ [code: number]: string }}
 */
const statusLines = {
  200: '200 OK',
  201: '201 Created',
  204: '204 No Content',
  400: '400 Bad Request',
  401: '401 Unauthorized',
  403: '403 Forbidden',
  404: '404 Not Found',
  409: '409 Conflict',
  422: '422 Unprocessable Entity',
  429: '429 Too Many Requests',
  500: '500 Internal Server Error',
  503: '503 Service Unavailable'
}

/**
 * @param {number} code
 * @param {string} [reason]
 */
export const statusLine = (code, reason = '') => statusLines[code] ?? `${code} ${reason}`

const apiErrorBrand = Symbol('apiError')

/**
 * Create an error that, when thrown from an api handler, produces a response with the given http
 * status code and an any-encoded `{ error: message, ...extra }` body. Only errors created by this
 * function expose their message to clients - any other exception results in a generic 500. Use
 * `extra` for machine-readable fields, conventionally `{ code: 'comment-not-found' }`. Clients
 * treat `5xx` and `429` as transient (retry with backoff) and any other `4xx` as permanent - see
 * the Errors section in API.md.
 *
 * @param {number} status
 * @param {string} message
 * @param {{ [key: string]: any }} [extra]
 */
export const apiError = (status, message, extra = undefined) => Object.assign(new Error(message), { status, extra, [apiErrorBrand]: true })

/**
 * @param {any} err
 * @return {err is Error & { status: number, extra?: { [key: string]: any } }}
 */
export const isApiError = err => err?.[apiErrorBrand] === true

/**
 * Throw the uniform missing-permission 403 unless `permissions` contains `required` (the
 * containment check `hasPermissions` in permissions.js): the message names the missing fragment
 * and the body carries it as `{ code: 'missing-permission', required }`. Every rest endpoint is
 * gated this way on its `endpoint` facet before its handler runs; handlers state their semantic
 * requirements (ydoc/awareness/history/delete) the same way at their head. `required` is a
 * permission object of the scope of `permissions` - `createDocumentPermissions({ ydoc: '-r--' })`
 * (an org permission accepts only `endpoint`). `null` permissions (no answer from the auth
 * plugin) contain nothing and fail every requirement.
 *
 * @template {import('./permissions.js').NormalizedPermissions | null} P
 * @param {P} permissions
 * @param {import('./permissions.js').RequiredPermissions<P>} required
 */
export const checkPermissions = (permissions, required) => {
  if (!perm.hasPermissions(permissions, required)) {
    throw apiError(403, `requires permission ${JSON.stringify(required)}`, { code: 'missing-permission', required })
  }
}

export class EncodedAny {
  /**
   * @param {Uint8Array} bytes
   */
  constructor (bytes) {
    this.bytes = bytes
  }
}

/**
 * Mark bytes returned from an api handler as already lib0-any-encoded (e.g. cached in redis).
 * They are served as `application/x-lib0any` without re-encoding, and transcoded to json when the
 * client sends `Accept: application/json` - unlike a plain `Uint8Array` return, which is always
 * sent as opaque `application/octet-stream`.
 *
 * @param {Uint8Array} bytes
 */
export const encodedAny = bytes => new EncodedAny(bytes)

/**
 * Run one auth hook. A branded apiError is the plugin's own answer - a 401 from `authenticate`
 * rejecting a credential, a 503 outage from either hook - and passes through; any other throw is
 * an infrastructure failure: 503, transient like the ws recheck's 1013. Deny is a value on both
 * hooks (`authenticate` → null: an anonymous caller; `authorize` → null: no permissions).
 *
 * @template T
 * @param {'authenticate'|'authorize'} hook
 * @param {() => Promise<T>} run
 */
const runAuthHook = async (hook, run) => {
  try {
    return await run()
  } catch (err) {
    if (isApiError(err)) throw err
    log.warn({ err, hook }, 'auth plugin failed')
    throw apiError(503, `${hook} unavailable`)
  }
}

/**
 * Normalize an `authorize` answer for `scope` - the one place every answer passes (rest, ws
 * upgrade, ws recheck). `null` stays null (no permissions), a well-formed answer of an unknown
 * future type version is denied whole (null) with a warning, a known-but-wrong-scope type or an
 * invalid object throws - a plugin bug, never a silent denial.
 *
 * @template {perm.PermissionScope} S
 * @param {S} scope
 * @param {any} answer
 * @return {perm.ToNormalizedPermissionType<S> | null}
 */
export const normalizeAuthorizeAnswer = (scope, answer) => {
  if (answer == null) return null
  const type = `permissions:${scope}:v1`
  if (answer.type !== type) {
    if (typeof answer.type === 'string' && !perm.isKnownPermissionsType(answer.type)) {
      log.warn({ type: answer.type, scope }, 'unknown permissions type, denying')
      return null
    }
    throw error.create(`auth plugin: authorize answered ${JSON.stringify(answer.type)} to a '${scope}' question`)
  }
  return /** @type {any} */ (perm.normalizePermissions(answer))
}

/**
 * The auth funnel every rest request and ws upgrade passes: `authenticate` the caller (null =
 * anonymous), then `authorize` against the route's scope and normalize the answer (null = no
 * permissions - the gates answer 403 naming what is missing). Errors: see `runAuthHook`; a
 * malformed answer or authInfo escapes unbranded - a logged 500, never a silent denial.
 *
 * @template {perm.PermissionScope} S
 * @param {import('./index.js').YHub} yhub
 * @param {import('uws').HttpRequest} req - the live uws request; must be entered synchronously
 * @param {S} scope
 * @param {perm.PermissionResourceId<S>} resourceId - the resource the route addresses, in the scope's shape
 * @returns {Promise<{ authInfo: t.UserAuthInfo | null, permissions: perm.ToNormalizedPermissionType<S> | null }>}
 */
export const resolvePermissions = async (yhub, req, scope, resourceId) => {
  const auth = /** @type {t.AuthPlugin<any>} */ (yhub.conf.server?.auth)
  const authInfo = await runAuthHook('authenticate', () => auth.authenticate(req))
  if (authInfo != null) s.$string.expect(authInfo.userid)
  const answer = await runAuthHook('authorize', () => auth.authorize(scope, resourceId, authInfo))
  return { authInfo, permissions: normalizeAuthorizeAnswer(scope, answer) }
}

const apiMethods = /** @type {{ get: 'get', post: 'post', put: 'put', patch: 'patch', delete: 'del' }} */ ({ get: 'get', post: 'post', put: 'put', patch: 'patch', delete: 'del' })
const apiSegmentRegex = /^[A-Za-z0-9_-]+$/

/**
 * Resolve and validate `conf.server.apiPrefix` (default: 'api'). All routes - built-in rest
 * endpoints, custom endpoints, and the websocket route - are mounted under this segment.
 *
 * @param {import('./index.js').YHub} yhub
 */
export const resolveApiPrefix = yhub => {
  const prefix = yhub.conf.server?.apiPrefix ?? 'api'
  if (typeof prefix !== 'string' || !apiSegmentRegex.test(prefix)) {
    throw error.create(`invalid api prefix "${prefix}" - must be a single path segment`)
  }
  return prefix
}

/**
 * Compile a `$query`/`$body` spec. `s.$` lifts a shape object to `s.$object` (values
 * recursively: literals to $literal, arrays to $union) and passes prebuilt schemas through.
 *
 * @param {any} spec
 * @param {string} name
 * @param {string} method
 * @param {'$query'|'$body'} kind
 * @returns {{ $schema: s.Schema<any>, coerce: (o: any) => { err: string|null, result: any } }}
 */
const compileSpec = (spec, name, method, kind) => {
  try {
    const $schema = s.$(spec)
    return { $schema, coerce: s.coerce($schema) }
  } catch (_err) {
    throw error.create(`api endpoint "${name}": invalid ${method}.${kind}`)
  }
}

/**
 * Register the built-in rest endpoints and the custom endpoints defined in `conf.server.api`
 * under `/{apiPrefix}/{name}/{version}/...` (default prefix: `api`). The built-ins register
 * first, so a custom endpoint colliding with one fails at startup like any duplicate. See API.md.
 *
 * @param {import('./index.js').YHub} yhub
 * @param {import('uws').TemplatedApp} app
 */
export const registerApi = (yhub, app) => {
  const prefix = resolveApiPrefix(yhub)
  /**
   * @type {Set<string>}
   */
  const registered = new Set()
  // the websocket endpoint is mounted at /{prefix}/ws/v1/{org}/{docid} via app.ws (see
  // registerWebsocketServer in server.js) - occupy its route key so a colliding custom endpoint
  // fails at startup like any duplicate
  registered.add('ws/v1/2')
  // builtin endpoint names are reserved: one name in the `endpoint` permission facet must mean
  // one route family, and a custom route squatting e.g. `ydoc` (in any version) would blur what
  // an `endpoint: { ydoc: ... }` grant covers. 'ws' is the websocket route's own entry in the
  // facet (`r` opens the socket, `u` admits doc updates - see server.js), reserved beyond the
  // depth-keyed entry above.
  const builtinNames = new Set([...builtinApi.map(e => e.name), 'ws'])
  ;[...builtinApi, ...(yhub.conf.server?.api ?? [])].forEach(endpoint => {
    const builtin = builtinApi.includes(endpoint)
    const { name, version = 'v1', scope = 'document', path = '' } = endpoint
    if (typeof name !== 'string' || !apiSegmentRegex.test(name) || typeof version !== 'string' || !apiSegmentRegex.test(version) || (scope !== 'document' && scope !== 'org' && scope !== 'global')) {
      throw error.create(`invalid api endpoint: name="${name}" version="${version}" scope="${scope}"`)
    }
    if (!builtin && builtinNames.has(name)) {
      throw error.create(`api endpoint "${name}" reuses a builtin endpoint name (refused in any version)`)
    }
    // an invalid cors config fails at startup, like every other endpoint validation here - with
    // the endpoint named, since the message alone can't tell an override from `server.cors`
    /**
     * @type {import('./cors.js').ResolvedCors|null}
     */
    let cors = null
    try {
      cors = resolveCors(yhub.conf.server?.cors, endpoint.cors)
    } catch (err) {
      throw error.create(`${/** @type {Error} */ (err).message} (endpoint "${name}")`)
    }
    /**
     * @type {Array<string>}
     */
    const pathParams = []
    if (path !== '') {
      if (path[0] !== '/') throw error.create(`api path must start with "/": "${path}" (endpoint "${name}")`)
      path.slice(1).split('/').forEach(seg => {
        const param = seg[0] === ':' ? seg.slice(1) : null
        if (param == null || !apiSegmentRegex.test(param) || param === 'org' || param === 'docid' || param === 'branch' || pathParams.includes(param)) {
          throw error.create(`invalid api path "${path}" (endpoint "${name}")`)
        }
        pathParams.push(param)
      })
    }
    // uws numbers only ":" segments, in order, regardless of interleaved static segments
    const paramOffset = scope === 'document' ? 2 : (scope === 'org' ? 1 : 0)
    // one name may serve several routes (e.g. collection + item) as long as their total segment
    // counts differ - routes of equal depth would collapse to the same uws pattern
    const routeKey = `${name}/${version}/${paramOffset + pathParams.length}`
    if (registered.has(routeKey)) {
      throw error.create(`duplicate api endpoint "${name}" (version "${version}", ${paramOffset + pathParams.length} url params)`)
    }
    registered.add(routeKey)
    const pattern = `/${prefix}/${name}/${version}${scope === 'global' ? '' : '/:org'}${scope === 'document' ? '/:docid' : ''}${path}`
    const methods = /** @type {Array<keyof typeof apiMethods>} */ (Object.keys(apiMethods)).filter(method => endpoint[method] != null)
    if (methods.length === 0) {
      throw error.create(`api endpoint "${name}" defines no method handlers`)
    }
    methods.forEach(method => {
      const def = endpoint[method]
      if (typeof def?.handler !== 'function') {
        throw error.create(`api endpoint "${name}": ${method}.handler must be a function`)
      }
      // the crud position a method needs in the effective endpoint mask follows its http verb
      const requiredEndpoint = perm.createPermissions(scope, { endpoint: { [name]: /** @type {perm.CRUD} */ (({ get: '-r--', post: 'c---', put: '--u-', patch: '--u-', delete: '---d' })[method]) } })
      const querySpec = def.$query ?? null
      const coerceQuery = querySpec == null ? null : compileSpec(querySpec, name, method, '$query').coerce
      const queryDeclaresBranch = querySpec != null && scope === 'document' && Object.hasOwn(/** @type {object} */ (s.$$object.check(querySpec) ? querySpec.shape : querySpec), 'branch')
      // fetch clients can't send GET bodies - a get endpoint declaring $body would 400 every request
      if (def.$body != null && method === 'get') {
        throw error.create(`api endpoint "${name}": get cannot declare $body`)
      }
      const bodySpec = def.$body == null ? null : compileSpec(def.$body, name, method, '$body')
      app[apiMethods[method]](pattern, createApiHandler(yhub, {
        method,
        handler: /** @type {(req: t.ApiRequest) => any} */ (def.handler),
        scope,
        requiredEndpoint,
        pathParams,
        paramOffset,
        coerceQuery,
        bodySpec,
        queryDeclaresBranch,
        cors
      }))
    })
    // one endpoint owns exactly one uws pattern (see routeKey above), so a single preflight
    // route covers it and can advertise precisely the methods registered on it. Without cors
    // there is nothing to preflight - the route stays unregistered and uws answers 404.
    if (cors != null) {
      const allowedMethods = [...methods.map(m => m.toUpperCase()), 'OPTIONS'].join(', ')
      app.options(pattern, (res, req) => {
        const origin = req.getHeader('origin')
        const host = req.getHeader('host')
        const url = req.getUrl()
        res.cork(() => {
          // the status must be written before any header - otherwise uws locks it to "200 OK"
          res.writeStatus('204 No Content')
          // rfc 9110: an options response says what the resource supports
          res.writeHeader('Allow', allowedMethods)
          if (!writeCorsPreflight(cors, res, origin, allowedMethods) && origin !== '') {
            // the denial itself is spec-shaped (no Access-Control header at all), but it would
            // otherwise be the only origin denial that leaves no server-side trace
            log.info({ path: url, origin, host }, 'preflight denied, origin not allowed')
          }
          res.end()
        })
      })
    }
  })
}

/**
 * @param {import('./index.js').YHub} yhub
 * @param {object} opts
 * @param {'get'|'post'|'put'|'patch'|'delete'} opts.method
 * @param {(req: t.ApiRequest) => any} opts.handler
 * @param {'document'|'org'|'global'} opts.scope
 * @param {perm.Permissions} opts.requiredEndpoint - the scope's permission object naming the route's verb class
 * @param {Array<string>} opts.pathParams
 * @param {number} opts.paramOffset
 * @param {((o: any) => { err: string|null, result: any })|null} opts.coerceQuery
 * @param {{ $schema: s.Schema<any>, coerce: (o: any) => { err: string|null, result: any } }|null} opts.bodySpec
 * @param {boolean} opts.queryDeclaresBranch
 * @param {import('./cors.js').ResolvedCors|null} opts.cors
 * @returns {(res: import('uws').HttpResponse, req: import('uws').HttpRequest) => void}
 */
const createApiHandler = (yhub, { method, handler, scope, requiredEndpoint, pathParams, paramOffset, coerceQuery, bodySpec, queryDeclaresBranch, cors }) => (res, req) => {
  const ctx = { aborted: false }
  // assigned once the headers are snapshotted - stays false when reading the request throws
  let acceptsJson = false
  // likewise - an unknown origin simply receives no cors headers
  let origin = ''
  /**
   * Every response goes through here. `skip` holds the lowercased headers a handler's own
   * `Response` already defines, which win over the configured ones.
   *
   * @param {import('uws').HttpResponse} res
   * @param {Set<string>} [skip]
   */
  const writeHeaders = (res, skip) => writeCorsResponse(cors, res, origin, skip)
  /**
   * @type {t.ApiRequest|null}
   */
  let apiReq = null
  /**
   * @type {Array<Buffer>}
   */
  const bodyChunks = []
  /**
   * @type {(body: Uint8Array<ArrayBuffer>) => void}
   */
  let resolveBody = _body => {}
  /**
   * @type {(err: Error) => void}
   */
  let rejectBody = _err => {}
  /**
   * @type {Promise<Uint8Array<ArrayBuffer>>}
   */
  const bodyPromise = promise.create((resolve, reject) => { resolveBody = resolve; rejectBody = reject })
  // a rejected body (aborted request) must not raise unhandled rejections when nobody reads it
  bodyPromise.catch(() => {})
  res.onAborted(() => {
    ctx.aborted = true
    if (apiReq != null) apiReq.aborted = true
    // unblock anything awaiting the body - the request will never complete
    rejectBody(error.create('request aborted'))
  })
  try {
    res.onData((chunk, isLast) => {
      // the chunk must be copied - uws neuters the ArrayBuffer on return
      bodyChunks.push(Buffer.from(chunk.slice(0)))
      if (isLast) resolveBody(Buffer.concat(bodyChunks))
    })
    // snapshot the stack-allocated uws request - it is discarded once this callback yields.
    // getQuery() must be read before any keyed getQuery('..') call - uws percent-decodes in place
    const path = req.getUrl()
    const rawQuery = req.getQuery()
    const org = scope === 'global' ? null : /** @type {string} */ (req.getParameter(0))
    const docid = scope === 'document' ? /** @type {string} */ (req.getParameter(1)) : null
    /**
     * @type {{ [key: string]: any }}
     */
    let query = Object.fromEntries(new URLSearchParams(rawQuery))
    // derived from the parsed query so that repeated ?branch keys resolve like req.query (last wins)
    const branch = scope === 'document' ? /** @type {string} */ (query.branch ?? 'main') : null
    /**
     * @type {{ [name: string]: string }}
     */
    const params = {}
    pathParams.forEach((param, i) => { params[param] = /** @type {string} */ (req.getParameter(paramOffset + i)) })
    /**
     * @type {{ [name: string]: string }}
     */
    const headers = {}
    req.forEach((key, value) => { headers[key] = value })
    acceptsJson = (headers.accept ?? '').includes('application/json')
    origin = headers.origin ?? ''
    // a cross-site page can fire requests the browser never preflights - "simple" POSTs
    // carrying the visitor's ambient credentials, GETs whose timing is observable even though
    // the response is withheld - and cors only ever hides responses. So every method checks the
    // origin before anything else runs: cross-origin is denied unless cors allows it,
    // same-origin passes (see originAllowed)
    if (!originAllowed(cors, origin, headers.host ?? '', headers['sec-fetch-site'] ?? '')) {
      log.info({ path, origin, host: headers.host }, 'api request denied, origin not allowed')
      // the gate only denies requests carrying an `Origin` - a browser is on the other end, so
      // the body is json regardless of `Accept`
      sendErrorResponse(res, writeHeaders, statusLine(403), { error: 'origin not allowed', code: 'origin-not-allowed' }, true)
      return
    }
    const docRef = scope === 'document' ? /** @type {t.DocRef} */ ({ org, docid, branch }) : null
    // the resource the route addresses, in the shape `authorize` expects for its scope
    const resourceId = docRef ?? (scope === 'org' ? /** @type {{ org: string }} */ ({ org }) : {})
    log.debug({ endpoint: `${method.toUpperCase()} ${path}` }, 'api request')
    // auth starts synchronously - `authenticate` reads the live uws request
    const authPromise = resolvePermissions(yhub, req, scope, resourceId)
    const handleRequest = async () => {
      // a rejection is handled by the catch below, which waits for the upload to complete first
      const { authInfo, permissions } = await authPromise
      if (ctx.aborted) return
      // every rest endpoint - builtin and custom alike - is gated by the `endpoint` facet
      // before its handler runs; the semantic facets (ydoc/awareness/history/delete) are the
      // handler's business, checked the same way at the handler head
      checkPermissions(permissions, requiredEndpoint)
      if (coerceQuery != null) {
        // a declared `branch` attribute validates the effective branch - materialize the server
        // default so `branch: 'main'` accepts requests that omit ?branch
        if (queryDeclaresBranch && query.branch === undefined) query.branch = branch
        const { err, result } = coerceQuery(query)
        if (err != null) throw apiError(400, `invalid query: ${err}`, { code: 'invalid-query' })
        query = result
      }
      /**
       * @type {any}
       */
      let body
      if (bodySpec != null) {
        const raw = await bodyPromise
        const isJson = (headers['content-type'] ?? '').includes('application/json')
        /**
         * @type {any}
         */
        let decoded
        try {
          decoded = isJson ? JSON.parse(string.decodeUtf8(raw)) : buffer.decodeAny(raw)
        } catch (_err) {
          throw apiError(400, 'invalid body', { code: 'invalid-body' })
        }
        if (isJson) {
          // json can't express all lib0-any types - coerce (e.g. base64 strings to $uint8Array fields)
          const { err, result } = bodySpec.coerce(decoded)
          if (err != null) throw apiError(400, `invalid body: ${err}`, { code: 'invalid-body' })
          body = result
        } else {
          // lib0-any expresses exact types - validate only, never coerce
          if (!bodySpec.$schema.check(decoded)) throw apiError(400, 'invalid body', { code: 'invalid-body' })
          body = decoded
        }
      }
      apiReq = /** @type {t.ApiRequest} */ ({
        yhub,
        method,
        path,
        org,
        docid,
        branch,
        docRef,
        params,
        headers,
        authInfo,
        permissions,
        aborted: ctx.aborted,
        query,
        body,
        bytes: () => bodyPromise,
        any: () => bodyPromise.then(buffer.decodeAny)
      })
      const result = await handler(apiReq)
      if (ctx.aborted) return
      if (result instanceof Response) {
        const body = new Uint8Array(await result.arrayBuffer())
        if (ctx.aborted) return
        // the handler's own headers win over the configured ones - writing both would emit the
        // header twice. `Headers` keys are already lowercased.
        /**
         * @type {Set<string>}
         */
        const own = new Set()
        result.headers.forEach((_value, key) => own.add(key))
        res.cork(() => {
          res.writeStatus(result.statusText !== '' ? `${result.status} ${result.statusText}` : statusLine(result.status))
          writeHeaders(res, own)
          result.headers.forEach((value, key) => {
            // uws manages the response framing
            if (key !== 'content-length' && key !== 'transfer-encoding') res.writeHeader(key, value)
          })
          res.end(body)
        })
      } else if (result == null) {
        res.cork(() => {
          res.writeStatus('204 No Content')
          writeHeaders(res)
          res.end()
        })
      } else {
        const isString = typeof result === 'string'
        const isRaw = result instanceof Uint8Array
        const isEncoded = result instanceof EncodedAny
        /**
         * @type {string|Uint8Array}
         */
        let body
        let contentType
        if (isString) {
          body = result
          contentType = 'text/plain; charset=utf-8'
        } else if (isRaw) {
          // plain bytes are opaque - only `encodedAny(..)` results participate in json negotiation
          body = result
          contentType = 'application/octet-stream'
        } else if (acceptsJson) {
          body = JSON.stringify(isEncoded ? buffer.decodeAny(result.bytes) : result, jsonReplacer)
          contentType = 'application/json'
        } else {
          body = isEncoded ? result.bytes : buffer.encodeAny(result)
          contentType = 'application/x-lib0any'
        }
        res.cork(() => {
          res.writeStatus('200 OK')
          writeHeaders(res)
          res.writeHeader('Content-Type', contentType)
          res.end(body)
        })
      }
    }
    handleRequest().catch(async err => {
      // don't respond while the client is still uploading - wait for the body to complete
      await bodyPromise.catch(() => {})
      if (ctx.aborted) {
        log.debug({ err, path }, 'api request failed after abort')
      } else if (err instanceof t.DocDeletedError) {
        // raised by `getDoc`, so every endpoint that reads the document - built-in or custom -
        // reports a deleted one as absent rather than as a server error. `code` matters because
        // a docid that was never written answers 200 with an empty document.
        sendErrorResponse(res, writeHeaders, statusLine(404), { error: 'Not Found', code: 'doc-deleted' }, acceptsJson)
      } else if (isApiError(err)) {
        sendErrorResponse(res, writeHeaders, statusLine(err.status), { error: err.message, ...err.extra }, acceptsJson)
      } else {
        log.error({ err, path }, 'error handling api request')
        sendErrorResponse(res, writeHeaders, '500 Internal Server Error', { error: 'Internal server error' }, acceptsJson)
      }
    })
  } catch (err) {
    if (ctx.aborted) {
      // reading the aborted request threw - the connection is gone, don't respond
      log.debug({ err }, 'api request could not be read')
    } else {
      log.error({ err }, 'error handling api request')
      sendErrorResponse(res, writeHeaders, '500 Internal Server Error', { error: 'Internal server error' }, acceptsJson)
    }
  }
}
