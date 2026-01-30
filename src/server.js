import * as uws from 'uws'
import * as logging from 'lib0/logging'
import * as error from 'lib0/error'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as promise from 'lib0/promise'
import * as Y from '@y/y'
import * as s from 'lib0/schema'
import * as time from 'lib0/time'
import * as number from 'lib0/number'
import * as t from './types.js'
import * as protocol from './protocol.js'
import * as array from 'lib0/array'

const log = logging.createModuleLogger('@y/hub/ws')

export class YHubServer {
  /**
   * @param {import('./index.js').YHub} yhub
   * @param {t.YHubConfig} conf
   * @param {uws.TemplatedApp} app
   */
  constructor (yhub, conf, app) {
    this.yhub = yhub
    this.conf = conf
    this.uwsApp = app
  }

  async destroy () {
    this.uwsApp.close()
  }
}

/**
 * @param {import('./index.js').YHub} yhub
 * @param {t.YHubConfig} conf
 */
export const createYHubServer = async (yhub, conf) => {
  const app = uws.App({})
  const yhubServer = new YHubServer(yhub, conf, app)
  yhub.server = yhubServer
  registerWebsocketServer(yhub, app)
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
  app.post('/rollback/:org/:docid', (res, req) => {
    const room = reqToRoom(req)
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
          const { contentmap: contentmapBin, nongcDoc: nongcDocBin } = await yhub.getDoc(room, { nongc: true, contentmap: true })
          const contentmap = Y.decodeContentMap(contentmapBin)
          const ydoc = Y.createDocFromUpdate(nongcDocBin)
          const reducedAttributions = filterContentMapHelper(contentmap, from, to, by, contentIds)
          const revertIds = Y.createContentIdsFromContentMap(reducedAttributions)
          ydoc.once('update', update => {
            const now = time.getUnixTime()
            yhub.stream.addMessage(room, {
              type: 'ydoc:update:v1',
              update,
              contentmap: Y.encodeContentMap(Y.createContentMapFromContentIds(Y.createContentIdsFromUpdate(update), [Y.createContentAttribute('insert', 'system'), Y.createContentAttribute('insertAt', now)], [Y.createContentAttribute('delete', 'system'), Y.createContentAttribute('deleteAt', now)]))
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
          ydoc.destroy()
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
  app.get('/changeset/:org/:docid', async (res, req) => {
    const room = reqToRoom(req)
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
    const { nongcDoc: nongcDocBin, contentmap: contentmapBin } = await yhub.getDoc(room, { nongc: true, contentmap: true })
    const ydoc = Y.createDocFromUpdate(nongcDocBin)
    const contentmap = Y.decodeContentMap(contentmapBin)
    const filteredAttributions = filterContentMapHelper(contentmap, from, to, by, undefined)
    const beforeContentIds = Y.createContentIdsFromContentMap(filterContentMapHelper(contentmap, 0, from != null ? from - 1 : null, undefined, undefined))
    const afterContentIds = Y.createContentIdsFromContentMap(filterContentMapHelper(contentmap, 0, to, undefined, undefined))
    const docUpdate = Y.encodeStateAsUpdate(ydoc)
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
  app.get('/activity/:org/:docid', async (res, req) => {
    const room = reqToRoom(req)
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
    const { contentmap: contentmapBin, nongcDoc: nongcDocBin } = await yhub.getDoc(room, { nongc: true, contentmap: true })
    const contentmap = Y.decodeContentMap((contentmapBin))
    const ydoc = Y.createDocFromUpdate(nongcDocBin)
    const filteredAttributions = filterContentMapHelper(contentmap, from, to, undefined, undefined)
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
        const beforeContentIds = Y.createContentIdsFromContentMap(filterContentMapHelper(contentmap, 0, act.from != null ? act.from - 1 : null, undefined, undefined))
        const afterContentIds = Y.createContentIdsFromContentMap(filterContentMapHelper(contentmap, 0, act.to, undefined, undefined))
        const docUpdate = Y.encodeStateAsUpdate(ydoc)
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
    const port = conf.server?.port || 4000
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
  return new YHubServer(yhub, conf, app)
}

let _idCnt = 0

/**
 * @typedef {import('./stream.js').StreamSubscriber} SSubscriber
 */

/**
 * @implements SSubscriber
 */
class WSUser {
  /**
   * @param {import('./index.js').YHub} yhub
   * @param {uws.WebSocket<WSUser>|null} ws
   * @param {t.Room} room
   * @param {boolean} hasWriteAccess
   * @param {{ userid: string }} authInfo
   * @param {boolean} gc
   */
  constructor (yhub, ws, room, hasWriteAccess, authInfo, gc) {
    this.yhub = yhub
    /**
     * @type {uws.WebSocket<WSUser>|null}
     */
    this.ws = ws
    this.room = room
    this.hasWriteAccess = hasWriteAccess
    this.gc = gc
    /**
     * @type {string}
     */
    this.initialRedisSubId = '0'
    this.subs = new Set()
    /**
     * This is just an identifier to keep track of the user for logging purposes.
     */
    this.id = _idCnt++
    this.authInfo = authInfo
    /**
     * Identifies the User globally.
     * Note that several clients can have the same userid (e.g. if a user opened several browser
     * windows)
     */
    this.userid = authInfo.userid
    /**
     * @type {number|null}
     */
    this.awarenessId = null
    this.awarenessLastClock = 0
    this.isClosed = false
    this.lastReceivedClock = '0'
  }

  /**
   * @param {t.Room} _room
   * @param {Array<t.Message>} ms
   */
  onStreamMessage (_room, ms) {
    const encoder = encoding.createEncoder()
    ms.forEach(message => {
      switch (message.type) {
        case 'ydoc:update:v1': {
          protocol.writeSyncUpdate(encoder, message.update)
          break
        }
        case 'awareness:v1': {
          protocol.writeAwarenessUpdate(encoder, message.update)
          break
        }
        default: {
          s.$never.expect(message)
        }
      }
    })
    const m = encoding.toUint8Array(encoder)
    if (this.ws == null) console.log('Client tried to send a message, but it isn\'t connected yet')
    this.ws?.send(m)
  }

  destroy () {
    this.yhub.stream.unsubscribe(this.room, this)
  }
}

/**
 * @param {uws.HttpRequest} req
 */
const reqToRoom = req => {
  const org = /** @type {string} */ (req.getParameter(0))
  const docid = /** @type {string} */ (req.getParameter(1))
  const branch = /** @type {string} */ (req.getQuery('branch')) ?? 'main'
  return { org, docid, branch }
}

/**
 * @param {import('./index.js').YHub} yhub
 * @param {uws.TemplatedApp} app
 */
const registerWebsocketServer = (yhub, app) => {
  app.ws('/ws/:org/:docid', /** @type {uws.WebSocketBehavior<WSUser>} */ ({
    compression: uws.SHARED_COMPRESSOR,
    maxPayloadLength: 100 * 1024 * 1024,
    idleTimeout: 60,
    sendPingsAutomatically: true,
    upgrade: async (res, req, context) => {
      const url = req.getUrl()
      const headerWsKey = req.getHeader('sec-websocket-key')
      const headerWsProtocol = req.getHeader('sec-websocket-protocol')
      const headerWsExtensions = req.getHeader('sec-websocket-extensions')
      let aborted = false
      res.onAborted(() => {
        console.log('Upgrading client aborted', { url })
        aborted = true
      })
      try {
        const room = reqToRoom(req)
        const gc = req.getQuery('gc') !== 'false' // default to true unless explicitly set to 'false'
        const authInfo = await yhub.conf.server?.auth.readAuthInfo(req)
        s.$string.expect(authInfo.userid)
        const accessType = authInfo && await yhub.conf.server?.auth.getAccessType(authInfo, room)
        if (authInfo == null || !t.hasReadAccess(accessType)) {
          res.cork(() => {
            res.writeStatus('401 Unauthorized').end('Unauthorized')
          })
          return
        }
        if (aborted) return
        res.cork(() => {
          res.upgrade(
            new WSUser(yhub, null, room, t.hasWriteAccess(accessType), authInfo, gc),
            headerWsKey,
            headerWsProtocol,
            headerWsExtensions,
            context
          )
        })
      } catch (err) {
        console.log(`Failed to auth to endpoint ${url}`, err)
        if (aborted) return
        res.cork(() => {
          res.writeStatus('401 Unauthorized').end('Unauthorized')
        })
      }
    },
    open: async (ws) => {
      const user = ws.getUserData()
      log(() => ['client connected (uid=', user.id, ', ip=', Buffer.from(ws.getRemoteAddressAsText()).toString(), ')'])
      const doctable = await yhub.getDoc(user.room, { gc: user.gc, nongc: !user.gc, awareness: true })
      const ydoc = doctable.gcDoc || doctable.nongcDoc || Y.encodeStateAsUpdate(new Y.Doc())
      if (user.isClosed) return
      ws.cork(() => {
        ws.send(protocol.encodeSyncStep1(Y.encodeStateVectorFromUpdate(ydoc)), true, false)
        ws.send(protocol.encodeSyncStep2(ydoc), true, true)
        const aw = doctable.awareness
        if (aw.states.size > 0) {
          ws.send(protocol.encodeAwareness(aw, array.from(aw.states.keys())), true, false)
        }
      })
      user.lastReceivedClock = doctable.lastClock
      yhub.stream.subscribe(user.room, user)
    },
    message: (ws, messageBuffer) => {
      const user = ws.getUserData()
      // don't read any messages from users without write access
      if (!user.hasWriteAccess) return
      // It is important to copy the data here
      const message = Buffer.from(messageBuffer.slice(0, messageBuffer.byteLength))
      const decoder = decoding.createDecoder(message)
      switch (decoding.readVarUint(decoder)) {
        case 0: { // sync message
          const syncMessageType = decoding.readVarUint(decoder)
          if (syncMessageType === protocol.messageSyncUpdate || syncMessageType === protocol.messageSyncStep2) {
            const update = decoding.readVarUint8Array(decoder)
            if (update.byteLength > 3) {
              const now = time.getUnixTime()
              const contentmap = Y.encodeContentMap(Y.createContentMapFromContentIds(
                Y.createContentIdsFromUpdate(update),
                [Y.createContentAttribute('insert', user.userid), Y.createContentAttribute('insertAt', now)],
                [Y.createContentAttribute('delete', user.userid), Y.createContentAttribute('deleteAt', now)]
              ))
              yhub.stream.addMessage(user.room, { type: 'ydoc:update:v1', contentmap, update })
            }
          } else if (syncMessageType === protocol.messageSyncStep1) {
            // can be safely ignored because we send the full initial state at the beginning
          } else {
            console.warn('Unknown sync message type', syncMessageType)
          }
          break
        }
        case 1: { // awareness message
          const update = decoding.readVarUint8Array(decoder)
          const awDecoder = decoding.createDecoder(update)
          const alen = decoding.readVarUint(awDecoder) // number of awareness updates
          const awId = decoding.readVarUint(awDecoder)
          if (alen === 1 && (user.awarenessId === null || user.awarenessId === awId)) { // only update awareness if len=1
            user.awarenessId = awId
            user.awarenessLastClock = decoding.readVarUint(awDecoder)
          }
          yhub.stream.addMessage(user.room, { type: 'awareness:v1', update })
          break
        }
      }
    },
    close: (ws, code, message) => {
      const user = ws.getUserData()
      user.awarenessId && yhub.stream.addMessage(user.room, { type: 'awareness:v1', update: protocol.encodeAwarenessUserDisconnected(user.awarenessId, user.awarenessLastClock) })
      user.isClosed = true
      log(() => ['client connection closed (uid=', user.id, ', code=', code, ', message="', Buffer.from(message).toString(), '")'])
      user.destroy()
    }
  }))
}

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
