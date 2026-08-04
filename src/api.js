import * as buffer from 'lib0/buffer'
import * as error from 'lib0/error'
import * as number from 'lib0/number'
import * as promise from 'lib0/promise'
import * as t from './types.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'api' })

/**
 * @param {import('uws').HttpResponse} res
 */
export const setCorsHeaders = (res) => {
  res.writeHeader('Access-Control-Allow-Origin', '*')
  res.writeHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.writeHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

/**
 * @param {import('uws').HttpResponse} res
 * @param {string} status
 * @param {{ [key: string]: any, error: string }} body
 */
export const sendErrorResponse = (res, status, body) => {
  const response = buffer.encodeAny(body)
  res.cork(() => {
    // the status must be written before any header - otherwise uws locks the status to "200 OK"
    res.writeStatus(status)
    setCorsHeaders(res)
    res.writeHeader('Content-Type', 'application/x-lib0any')
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
  500: '500 Internal Server Error'
}

/**
 * @param {number} code
 * @param {string} [reason]
 */
const statusLine = (code, reason = '') => statusLines[code] ?? `${code} ${reason}`

const apiErrorBrand = Symbol('apiError')

/**
 * Create an error that, when thrown from an api handler, produces a response with the given http
 * status code and an any-encoded `{ error: message, ...extra }` body. Only errors created by this
 * function expose their message to clients - any other exception results in a generic 500. Use
 * `extra` for machine-readable fields, conventionally `{ code: 'comment-not-found' }`.
 *
 * @param {number} status
 * @param {string} message
 * @param {{ [key: string]: any }} [extra]
 */
export const apiError = (status, message, extra = undefined) => Object.assign(new Error(message), { status, extra, [apiErrorBrand]: true })

/**
 * @param {import('./index.js').YHub} yhub
 * @param {import('uws').HttpRequest} req
 * @param {'r' | 'rw'} requiredAccess
 * @param {(authInfo: { userid: string }) => Promise<t.AccessType>|t.AccessType|null} getAccess
 * @returns {Promise<{ authInfo: { userid: string }, accessType: t.AccessType } | { error: string, status: string }>}
 */
const authenticate = async (yhub, req, requiredAccess, getAccess) => {
  // the auth module is required by $config - without it everything is rejected as unauthenticated
  if (yhub.conf.server?.auth == null) {
    return { error: 'Unauthorized', status: '401 Unauthorized' }
  }
  try {
    const authInfo = await yhub.conf.server.auth.readAuthInfo(req)
    if (authInfo == null) {
      return { error: 'Unauthorized', status: '401 Unauthorized' }
    }
    const accessType = await getAccess(authInfo)
    if (requiredAccess === 'rw' && !t.hasWriteAccess(accessType)) {
      return { error: 'Forbidden', status: '403 Forbidden' }
    }
    if (requiredAccess === 'r' && !t.hasReadAccess(accessType)) {
      return { error: 'Forbidden', status: '403 Forbidden' }
    }
    return { authInfo, accessType }
  } catch (_err) {
    return { error: 'Unauthorized', status: '401 Unauthorized' }
  }
}

/**
 * @param {import('./index.js').YHub} yhub
 * @param {import('uws').HttpRequest} req
 * @param {t.Room} room
 * @param {'r' | 'rw'} requiredAccess
 * @param {string|null} [purpose]
 */
export const authenticateRequest = (yhub, req, room, requiredAccess, purpose = null) =>
  authenticate(yhub, req, requiredAccess, authInfo => yhub.conf.server?.auth?.getAccessType(authInfo, room, purpose) ?? null)

const apiMethods = /** @type {{ get: 'get', post: 'post', put: 'put', patch: 'patch', delete: 'del' }} */ ({ get: 'get', post: 'post', put: 'put', patch: 'patch', delete: 'del' })
const apiSegmentRegex = /^[A-Za-z0-9_-]+$/

/**
 * Register the custom rest endpoints defined in `conf.server.api` under
 * `/{apiPrefix}/{version}/{name}/...` (default prefix: `api`). See API.md.
 *
 * @param {import('./index.js').YHub} yhub
 * @param {import('uws').TemplatedApp} app
 */
export const registerApi = (yhub, app) => {
  const prefix = yhub.conf.server?.apiPrefix ?? 'api'
  if (typeof prefix !== 'string' || !apiSegmentRegex.test(prefix) || ['ydoc', 'rollback', 'prune', 'changeset', 'activity', 'ws'].includes(prefix)) {
    throw error.create(`invalid api prefix "${prefix}" - must be a single path segment that doesn't collide with built-in routes`)
  }
  /**
   * @type {Set<string>}
   */
  const registered = new Set()
  yhub.conf.server?.api?.forEach(endpoint => {
    const { name, version = 'v1', scope = 'doc', path = '', accessPurpose = null } = endpoint
    if (typeof name !== 'string' || !apiSegmentRegex.test(name) || typeof version !== 'string' || !apiSegmentRegex.test(version) || (scope !== 'doc' && scope !== 'org' && scope !== 'global') || (accessPurpose !== null && typeof accessPurpose !== 'string')) {
      throw error.create(`invalid api endpoint: name="${name}" version="${version}" scope="${scope}"`)
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
    const paramOffset = scope === 'doc' ? 2 : (scope === 'org' ? 1 : 0)
    // one name may serve several routes (e.g. collection + item) as long as their total segment
    // counts differ - routes of equal depth would collapse to the same uws pattern
    const routeKey = `${version}/${name}/${paramOffset + pathParams.length}`
    if (registered.has(routeKey)) {
      throw error.create(`duplicate api endpoint "${name}" (version "${version}", ${paramOffset + pathParams.length} url params)`)
    }
    registered.add(routeKey)
    const pattern = `/${prefix}/${version}/${name}${scope === 'global' ? '' : '/:org'}${scope === 'doc' ? '/:docid' : ''}${path}`
    const methods = /** @type {Array<keyof typeof apiMethods>} */ (Object.keys(apiMethods)).filter(method => endpoint[method] != null)
    if (methods.length === 0) {
      throw error.create(`api endpoint "${name}" defines no method handlers`)
    }
    methods.forEach(method => {
      app[apiMethods[method]](pattern, createApiHandler(yhub, {
        method,
        handler: /** @type {(req: t.ApiRequest) => any} */ (endpoint[method]),
        requiredAccess: method === 'get' ? 'r' : 'rw',
        scope,
        accessPurpose,
        pathParams,
        paramOffset
      }))
    })
  })
}

/**
 * @param {import('./index.js').YHub} yhub
 * @param {object} opts
 * @param {'get'|'post'|'put'|'patch'|'delete'} opts.method
 * @param {(req: t.ApiRequest) => any} opts.handler
 * @param {'r'|'rw'} opts.requiredAccess
 * @param {'doc'|'org'|'global'} opts.scope
 * @param {string|null} opts.accessPurpose
 * @param {Array<string>} opts.pathParams
 * @param {number} opts.paramOffset
 * @returns {(res: import('uws').HttpResponse, req: import('uws').HttpRequest) => void}
 */
const createApiHandler = (yhub, { method, handler, requiredAccess, scope, accessPurpose, pathParams, paramOffset }) => (res, req) => {
  const ctx = { aborted: false }
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
    const docid = scope === 'doc' ? /** @type {string} */ (req.getParameter(1)) : null
    const branch = scope === 'doc' ? (req.getQuery('branch') ?? 'main') : null
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
    const room = scope === 'doc' ? /** @type {t.Room} */ ({ org, docid, branch }) : null
    log.debug({ endpoint: `${method.toUpperCase()} ${path}` }, 'api request')
    // auth starts synchronously - readAuthInfo reads the live uws request
    const auth = yhub.conf.server?.auth
    const authPromise = authenticate(yhub, req, requiredAccess, authInfo =>
      scope === 'doc'
        ? (auth?.getAccessType(authInfo, /** @type {t.Room} */ (room), accessPurpose) ?? null)
        : scope === 'org'
          ? (auth?.getOrgAccessType?.(authInfo, /** @type {string} */ (org), accessPurpose) ?? null)
          : (auth?.getGlobalAccessType?.(authInfo, accessPurpose) ?? null)
    )
    const handleRequest = async () => {
      const authResult = await authPromise
      if (ctx.aborted) return
      if ('error' in authResult) {
        // handled by the catch below, which waits for the upload to complete before responding
        throw apiError(number.parseInt(authResult.status), authResult.error)
      }
      /**
       * @type {URLSearchParams|null}
       */
      let query = null
      apiReq = /** @type {t.ApiRequest} */ ({
        yhub,
        method,
        path,
        org,
        docid,
        branch,
        room,
        params,
        headers,
        authInfo: authResult.authInfo,
        accessType: /** @type {'r'|'rw'} */ (authResult.accessType),
        aborted: ctx.aborted,
        get query () {
          return query ?? (query = new URLSearchParams(rawQuery))
        },
        bytes: () => bodyPromise,
        any: () => bodyPromise.then(buffer.decodeAny)
      })
      const result = await handler(apiReq)
      if (ctx.aborted) return
      if (result instanceof Response) {
        const body = new Uint8Array(await result.arrayBuffer())
        if (ctx.aborted) return
        res.cork(() => {
          res.writeStatus(result.statusText !== '' ? `${result.status} ${result.statusText}` : statusLine(result.status))
          // default cors headers, unless the handler's Response controls cors itself
          if (!result.headers.has('access-control-allow-origin')) setCorsHeaders(res)
          result.headers.forEach((value, key) => {
            // uws manages the response framing
            if (key !== 'content-length' && key !== 'transfer-encoding') res.writeHeader(key, value)
          })
          res.end(body)
        })
      } else if (result == null) {
        res.cork(() => {
          res.writeStatus('204 No Content')
          setCorsHeaders(res)
          res.end()
        })
      } else {
        const isString = typeof result === 'string'
        const isRaw = result instanceof Uint8Array
        const body = isString || isRaw ? result : buffer.encodeAny(result)
        res.cork(() => {
          res.writeStatus('200 OK')
          setCorsHeaders(res)
          res.writeHeader('Content-Type', isString ? 'text/plain; charset=utf-8' : (isRaw ? 'application/octet-stream' : 'application/x-lib0any'))
          res.end(body)
        })
      }
    }
    handleRequest().catch(async err => {
      // don't respond while the client is still uploading - wait for the body to complete
      await bodyPromise.catch(() => {})
      if (ctx.aborted) {
        log.debug({ err, path }, 'api request failed after abort')
      } else if (err?.[apiErrorBrand] === true) {
        sendErrorResponse(res, statusLine(err.status), { error: err.message, ...err.extra })
      } else {
        log.error({ err, path }, 'error handling api request')
        sendErrorResponse(res, '500 Internal Server Error', { error: 'Internal server error' })
      }
    })
  } catch (err) {
    if (ctx.aborted) {
      // reading the aborted request threw - the connection is gone, don't respond
      log.debug({ err }, 'api request could not be read')
    } else {
      log.error({ err }, 'error handling api request')
      sendErrorResponse(res, '500 Internal Server Error', { error: 'Internal server error' })
    }
  }
}
