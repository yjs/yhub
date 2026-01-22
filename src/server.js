import * as uws from 'uws'
import * as env from 'lib0/environment'
import * as logging from 'lib0/logging'
import * as error from 'lib0/error'
import * as jwt from 'lib0/crypto/jwt'
import * as ecdsa from 'lib0/crypto/ecdsa'
import * as json from 'lib0/json'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { registerYWebsocketServer } from '../src/ws.js'
import * as promise from 'lib0/promise'
import * as api from './api.js'
import * as Y from '@y/y'
import * as s from 'lib0/schema'
import * as time from 'lib0/time'
import * as number from 'lib0/number'

const wsServerPublicKey = await ecdsa.importKeyJwk(json.parse(env.ensureConf('auth-public-key')))
// const wsServerPrivateKey = await ecdsa.importKeyJwk(json.parse(env.ensureConf('auth-private-key')))

class YWebsocketServer {
  /**
   * @param {uws.TemplatedApp} app
   */
  constructor (app) {
    this.app = app
  }

  async destroy () {
    this.app.close()
  }
}

/**
 * @param {Object} opts
 * @param {number} opts.port
 * @param {import('./storage.js').Storage} opts.store
 * @param {string} [opts.redisPrefix]
 * @param {string} opts.checkPermCallbackUrl
 * @param {(room:string,docname:string,client:import('./api.js').Api)=>void} [opts.initDocCallback] -
 * this is called when a doc is accessed, but it doesn't exist. You could populate the doc here.
 * However, this function could be called several times, until some content exists. So you need to
 * handle concurrent calls.
 */
export const createYWebsocketServer = async ({
  redisPrefix = 'y',
  port,
  store,
  checkPermCallbackUrl,
  initDocCallback = () => {}
}) => {
  checkPermCallbackUrl += checkPermCallbackUrl.slice(-1) !== '/' ? '/' : ''
  const app = uws.App({})
  await registerYWebsocketServer(app, '/ws/:room', store, redisPrefix, async (req) => {
    const room = /** @type {string} */ (req.getParameter(0))
    const headerWsProtocol = req.getHeader('sec-websocket-protocol')
    const [, , token] = /(^|,)yauth-(((?!,).)*)/.exec(headerWsProtocol) ?? [null, null, req.getQuery('yauth')]
    // Parse gc and branch query parameters BEFORE any await
    const gc = req.getQuery('gc') !== 'false' // default to true unless explicitly set to 'false'
    const branch = req.getQuery('branch') || 'main'
    if (token == null) {
      throw new Error('Missing Token')
    }
    // verify that the user has a valid token
    const { payload: userToken } = await jwt.verifyJwt(wsServerPublicKey, token)
    if (userToken.yuserid == null) {
      throw new Error('Missing userid in user token!')
    }
    const permUrl = new URL(`${room}/${userToken.yuserid}`, checkPermCallbackUrl)
    try {
      const perm = await fetch(permUrl).then(req => req.json())
      return { hasWriteAccess: perm.yaccess === 'rw', room, userid: perm.yuserid || '', gc, branch }
    } catch (e) {
      console.error('Failed to pull permissions from', { permUrl })
      throw e
    }
  }, { initDocCallback })

  const yhubApi = await api.createApiClient(store, redisPrefix)

  /**
   * @param {Y.ContentMap} contentMap
   * @param {number|undefined?} from
   * @param {number|undefined?} to
   * @param {string|undefined?} by
   * @param {Y.ContentIds|undefined} requestedIds
   */
  const filterContentMapHelper = (contentMap, from, to, by, requestedIds) => {
    if (requestedIds != null) {
      contentMap = Y.intersectContentMap(contentMap, requestedIds)
    }
    if (from || to || by) {
      /**
       * @param {Array<Y.ContentAttribute<any>>} attrs
       */
      const attrFilter = attrs => {
        if ((from || to) && !attrs.some(attr => (attr.name === 'insertAt' || attr.name === 'deleteAt') && (from == null || attr.val >= from) && (to == null || attr.val <= to))) {
          return false
        }
        if (by != null && !attrs.some(attr => (attr.name === 'insert' || attr.name === 'delete') && /** @type {string} */ (attr.val).split(',').includes(by))) {
          return false
        }
        return true
      }
      contentMap = Y.filterContentMap(
        contentMap,
        attrFilter,
        attrFilter
      )
    }
    return contentMap
  }

  // The REST API defined in `API.md`

  /**
   * @param {uws.HttpResponse} res
   */
  const setCorsHeaders = (res) => {
    res.writeHeader('Access-Control-Allow-Origin', '*')
    res.writeHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.writeHeader('Access-Control-Allow-Headers', 'Content-Type')
  }

  // Handle CORS preflight requests
  app.options('/*', (res, _req) => {
    res.cork(() => {
      setCorsHeaders(res)
      res.writeStatus('204 No Content')
      res.end()
    })
  })

  // POST /rollback/{guid} - Rollback changes matching the pattern
  app.post('/rollback/:room', (res, req) => {
    const room = /** @type {string} */ (req.getParameter(0))
    let buffer = Buffer.allocUnsafe(0)
    let aborted = false
    res.onAborted(() => {
      aborted = true
    })
    /**
     * @param {Buffer} buffer
     */
    const handleRollbackRequest = async buffer => {
      if (aborted) return
      try {
        const decoder = decoding.createDecoder(buffer)
        // body structure: { from?: number, to?: number, by?: string, contentIds?: buffer }
        const decodedBody = decoding.readAny(decoder)
        if (s.$object({ from: s.$number.optional, to: s.$number.optional, by: s.$string.optional, contentIds: s.$uint8Array.optional }).check(decodedBody)) {
          const { from, to, by, contentIds: contentIdsBin } = decodedBody
          const contentIds = contentIdsBin && Y.decodeContentIds(contentIdsBin)
          const { attributions, ydoc } = await yhubApi.getDoc(room, 'index', { gc: false, attributions: true })
          const reducedAttributions = filterContentMapHelper(attributions, from, to, by, contentIds)
          const revertIds = Y.createContentIdsFromContentMap(reducedAttributions)
          ydoc.once('update', update => {
            const now = time.getUnixTime()
            yhubApi.addMessage(room, 'index', {
              type: 'update:v1',
              update,
              attributions: Y.encodeContentMap(Y.createContentMapFromContentIds(Y.createContentIdsFromUpdate(update), [Y.createContentAttribute('insert', 'system'), Y.createContentAttribute('insertAt', now)], [Y.createContentAttribute('delete', 'system'), Y.createContentAttribute('deleteAt', now)]))
            })
          })
          Y.undoContentIds(ydoc, revertIds)
          if (!aborted) {
            // write response
            const encoder = encoding.createEncoder()
            encoding.writeAny(encoder, { success: true, message: 'Rollback completed' })
            const response = encoding.toUint8Array(encoder)
            res.cork(() => {
              setCorsHeaders(res)
              res.writeStatus('200 OK')
              res.writeHeader('Content-Type', 'application/octet-stream')
              res.end(response)
            })
          }
          return
        }
        // couldn't parse correctly. throw error
      } catch (_err) {
        console.warn('[rollback api] error parsing request')
      }
      if (!aborted) {
        const encoder = encoding.createEncoder()
        encoding.writeAny(encoder, { error: 'error consuming request' })
        const response = encoding.toUint8Array(encoder)
        res.cork(() => {
          setCorsHeaders(res)
          res.writeStatus('400 Bad Request')
          res.writeHeader('Content-Type', 'application/octet-stream')
          res.end(response)
        })
      }
    }
    res.onData((chunk, isLast) => {
      const chunkBuffer = Buffer.from(chunk)
      buffer = Buffer.concat([buffer, chunkBuffer])
      if (isLast) {
        handleRollbackRequest(buffer)
      }
    })
  })

  // GET /changeset/{guid} - Get attributed changes and document states
  app.get('/changeset/:room', async (res, req) => {
    const room = req.getParameter(0) || ''
    const by = req.getQuery('by')
    const _from = req.getQuery('from')
    const _to = req.getQuery('to')
    const from = _from == null ? null : number.parseInt(_from)
    const to = _to == null ? null : number.parseInt(_to)
    const includeYdoc = req.getQuery('ydoc') === 'true'
    const includeDelta = req.getQuery('delta') === 'true'
    const includeAttributions = req.getQuery('attributions') === 'true'
    let aborted = false
    res.onAborted(() => {
      aborted = true
      console.log('Request aborted')
    })
    const hubDoc = await yhubApi.getDoc(room, 'index', { gc: false, attributions: true })
    const filteredAttributions = filterContentMapHelper(hubDoc.attributions, from, to, by, undefined)
    const beforeContentIds = Y.createContentIdsFromContentMap(filterContentMapHelper(hubDoc.attributions, 0, from != null ? from - 1 : null, undefined, undefined))
    const afterContentIds = Y.createContentIdsFromContentMap(filterContentMapHelper(hubDoc.attributions, 0, to, undefined, undefined))
    const docUpdate = Y.encodeStateAsUpdate(hubDoc.ydoc)
    const prevDocUpdate = Y.intersectUpdateWithContentIds(docUpdate, beforeContentIds)
    const nextDocUpdate = Y.intersectUpdateWithContentIds(docUpdate, afterContentIds)
    /**
     * @type {any}
     */
    const response = {}
    if (includeAttributions) {
      response.attributions = Y.encodeContentMap(filteredAttributions)
    }
    if (includeYdoc || includeDelta) {
      if (includeYdoc) {
        response.prevDoc = prevDocUpdate
        response.nextDoc = nextDocUpdate
      }
      if (includeDelta) {
        const prevDoc = new Y.Doc()
        const nextDoc = new Y.Doc()
        Y.applyUpdate(prevDoc, prevDocUpdate)
        Y.applyUpdate(nextDoc, nextDocUpdate)
        const am = Y.createAttributionManagerFromDiff(prevDoc, nextDoc, { attrs: filteredAttributions })
        response.delta = nextDoc.get().toDelta(am).toJSON()
      }
    }
    const encoder = encoding.createEncoder()
    encoding.writeAny(encoder, response)
    const responseData = encoding.toUint8Array(encoder)
    if (!aborted) {
      res.cork(() => {
        setCorsHeaders(res)
        res.writeStatus('200 OK')
        res.writeHeader('Content-Type', 'application/octet-stream')
        res.end(responseData)
      })
    }
  })

  // GET /activity/{guid} - Get all editing timestamps for a document
  app.get('/activity/:room', async (res, req) => {
    const room = req.getParameter(0) || ''
    const from = number.parseInt(req.getQuery('from') || '0')
    const to = number.parseInt(req.getQuery('to') || number.MAX_SAFE_INTEGER.toString())
    const includeDelta = req.getQuery('delta') === 'true'
    const limit = number.parseInt(req.getQuery('limit') || number.MAX_SAFE_INTEGER.toString())
    const reverse = req.getQuery('order') === 'desc'
    const group = req.getQuery('group') !== 'false'
    let aborted = false
    res.onAborted(() => {
      aborted = true
      console.log('Request aborted')
    })
    const hubDoc = await yhubApi.getDoc(room, 'index', { gc: false, attributions: true })
    const filteredAttributions = filterContentMapHelper(hubDoc.attributions, from, to, undefined, undefined)
    /**
     * @type {Array<{ from: number, to: number, by: string|null }>}
     */
    const activity = []
    filteredAttributions.inserts.forEach(attrRange => {
      /**
       * @type {number?}
       */
      let t = null
      /**
       * @type {string?}
       */
      let by = null
      attrRange.attrs.forEach(attr => {
        if (attr.name === 'insertAt') {
          t = attr.val
        } else if (attr.name === 'insert') {
          by = attr.val
        }
      })
      if (t != null) {
        activity.push({
          from: t, to: t, by
        })
      }
    })
    filteredAttributions.deletes.forEach(attrRange => {
      /**
       * @type {number?}
       */
      let t = null
      /**
       * @type {string?}
       */
      let by = null
      attrRange.attrs.forEach(attr => {
        if (attr.name === 'deleteAt') {
          t = attr.val
        } else if (attr.name === 'delete') {
          by = attr.val
        }
      })
      if (t != null) {
        activity.push({
          from: t, to: t, by
        })
      }
    })
    activity.sort((a, b) => a.from - b.from)
    /**
     * @type {Array<{ from: number, to: number, by: string?, delta?: any }>}
     */
    const activityResult = []
    const groupDistance = group ? 1000 : 1
    /**
     * @type {{ from: number, to: number, by: string? }|null}
     */
    let lastActivity = null
    activity.forEach(act => {
      if (lastActivity != null && lastActivity.by === act.by && act.from - lastActivity.to < groupDistance) {
        lastActivity.to = act.to
      } else {
        activityResult.push(act)
        lastActivity = act
      }
    })
    if (reverse) {
      activityResult.reverse()
    }
    if (limit > 0) {
      activityResult.splice(limit)
    }
    if (includeDelta) {
      activityResult.forEach(act => {
        const actAttributions = filterContentMapHelper(filteredAttributions, act.from, act.to, undefined, undefined)
        const beforeContentIds = Y.createContentIdsFromContentMap(filterContentMapHelper(hubDoc.attributions, 0, act.from != null ? act.from - 1 : null, undefined, undefined))
        const afterContentIds = Y.createContentIdsFromContentMap(filterContentMapHelper(hubDoc.attributions, 0, act.to, undefined, undefined))
        const docUpdate = Y.encodeStateAsUpdate(hubDoc.ydoc)
        const prevDocUpdate = Y.intersectUpdateWithContentIds(docUpdate, beforeContentIds)
        const nextDocUpdate = Y.intersectUpdateWithContentIds(docUpdate, afterContentIds)
        const prevDoc = new Y.Doc()
        const nextDoc = new Y.Doc()
        Y.applyUpdate(prevDoc, prevDocUpdate)
        Y.applyUpdate(nextDoc, nextDocUpdate)
        const attrs = Y.createContentMapFromContentIds(Y.createContentIdsFromContentMap(actAttributions), [Y.createContentAttribute('insert', act.by), Y.createContentAttribute('insertAt', act.from)], [Y.createContentAttribute('delete', act.by), Y.createContentAttribute('deleteAt', act.from)])
        const am = Y.createAttributionManagerFromDiff(prevDoc, nextDoc, { attrs })
        // we only include the delta for the first type we find on ydoc.
        act.delta = nextDoc.get(nextDoc.share.keys().next().value || '').toDelta(am).toJSON()
      })
    }
    const encoder = encoding.createEncoder()
    encoding.writeAny(encoder, activityResult)
    const responseData = encoding.toUint8Array(encoder)
    if (!aborted) {
      res.cork(() => {
        setCorsHeaders(res)
        res.writeStatus('200 OK')
        res.writeHeader('Content-Type', 'application/octet-stream')
        res.end(responseData)
      })
    }
  })

  await promise.create((resolve, reject) => {
    app.listen(port, (token) => {
      if (token) {
        logging.print(logging.GREEN, '[y-redis] Listening to port ', port)
        resolve()
      } else {
        const err = error.create('[y-redis] Failed to lisen to port ' + port)
        reject(err)
        throw err
      }
    })
  })
  return new YWebsocketServer(app)
}
