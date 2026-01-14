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
        if (by != null && !attrs.some(attr => (attr.name === 'insertBy' || attr.name === 'deleteBy') && /** @type {string} */ (attr.val).split(',').includes(by))) {
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
          let { attributions, ydoc } = await yhubApi.getDoc(room, 'index', { gc: false, attributions: true })
          const reducedAttributions = filterContentMapHelper(attributions, from, to, by, contentIds)
          const revertIds = Y.createContentIdsFromContentMap(reducedAttributions)
          ydoc.once('update', update => {
            const now  = time.getUnixTime()
            yhubApi.addMessage(room, 'index', {
              type: 'update:v1',
              update,
              attributions: Y.encodeContentMap(Y.createContentMapFromContentIds(Y.createContentIdsFromUpdateV2(update), [Y.createContentAttribute('insertBy', 'system'), Y.createContentAttribute('insertAt', now)], [Y.createContentAttribute('deleteBy', 'system'), Y.createContentAttribute('deleteAt', now)]))
            })
          })
          Y.undoContentIds(ydoc, revertIds)
          if (!aborted) {
            // write response
            const encoder = encoding.createEncoder()
            encoding.writeAny(encoder, { success: true, message: 'Rollback completed (mock)' })
            const response = encoding.toUint8Array(encoder)
            res.writeStatus('200 OK')
            res.writeHeader('Content-Type', 'application/octet-stream')
            res.end(response)
          }
          return
        }
        // couldn't parse correctly. throw error
      } catch (_err) {
        console.warn('[rollback api] error parsing request')
      }
      const encoder = encoding.createEncoder()
      encoding.writeAny(encoder, { error: 'error consuming request' })
      const response = encoding.toUint8Array(encoder)
      res.writeStatus('400 Bad Request')
      res.writeHeader('Content-Type', 'application/octet-stream')
      res.end(response)
    }
    res.onData((chunk, isLast) => {
      const chunkBuffer = Buffer.from(chunk)
      buffer = Buffer.concat([buffer, chunkBuffer])
      if (isLast) {
        handleRollbackRequest(buffer)
      }
    })
  })

  // GET /history/{guid} - Get attributed changes and document states
  app.get('/history/:room', async (res, req) => {
    const room = req.getParameter(0) || ''
    const by = req.getQuery('by')
    const _from = req.getQuery('from')
    const _to = req.getQuery('to')
    const from = _from == null ? null : number.parseInt(_from)
    const to = _to == null ? null : number.parseInt(_to)
    const includeYdoc = req.getQuery('ydoc') === 'true'
    const includeDelta = req.getQuery('delta') === 'true'
    const includeAttributions = req.getQuery('attributions') === 'true'
    res.onAborted(() => {
      console.log('Request aborted')
    })
    const hubDoc = await yhubApi.getDoc(room, 'index', { gc: false, attributions: true })
    const filteredAttributions = filterContentMapHelper(hubDoc.attributions, from, to, by, undefined)
    const beforeContentIds = Y.createContentIdsFromContentMap(filterContentMapHelper(hubDoc.attributions, 0, from, undefined, undefined))
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
    res.writeStatus('200 OK')
    res.writeHeader('Content-Type', 'application/octet-stream')
    res.end(responseData)
  })

  // GET /timestamps/{guid} - Get all editing timestamps for a document
  app.get('/timestamps/:room', async (res, req) => {
    const room = req.getParameter(0) || ''
    const from = number.parseInt(req.getQuery('from') || '0')
    const to = number.parseInt(req.getQuery('to') || number.MAX_SAFE_INTEGER.toString())
    res.onAborted(() => {
      console.log('Request aborted')
    })
    const hubDoc = await yhubApi.getDoc(room, 'index', { attributions: true })
    const filteredAttributions = filterContentMapHelper(hubDoc.attributions, from, to, undefined, undefined)
    /**
     * @type {Set<number>}
     */
    const timestamps = new Set()
    filteredAttributions.deletes.forEach(attrRange => {
      attrRange.attrs.forEach(attr => {
        if (attr.name === 'insertAt') {
          timestamps.add(attr.val)
        }
      })
    })
    filteredAttributions.deletes.forEach(attrRange => {
      attrRange.attrs.forEach(attr => {
        if (attr.name === 'deleteAt') {
          timestamps.add(attr.val)
        }
      })
    })
    const sortedTimestamps = Array.from(timestamps).sort((a, b) => a - b)
    const response = {
      timestamps: sortedTimestamps
    }
    const encoder = encoding.createEncoder()
    encoding.writeAny(encoder, response)
    const responseData = encoding.toUint8Array(encoder)
    res.writeStatus('200 OK')
    res.writeHeader('Content-Type', 'application/octet-stream')
    res.end(responseData)
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
