import * as uws from 'uws'
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
import * as math from 'lib0/math'
import * as buffer from 'lib0/buffer'
import { logger } from './logger.js'

const log = logger.child({ module: 'ws' })

/**
 * @param {Y.ContentIds} contentids
 * @param {string} userid
 * @param {Array<{ k: string, v: string }>} customAttributions
 */
const createContentMapFromParams = (contentids, userid, customAttributions) => {
  const now = time.getUnixTime()
  return Y.encodeContentMap(Y.createContentMapFromContentIds(
    contentids,
    [Y.createContentAttribute('insert', userid), Y.createContentAttribute('insertAt', now), ...customAttributions.map(attr => Y.createContentAttribute('insert:' + attr.k, attr.v))],
    [Y.createContentAttribute('delete', userid), Y.createContentAttribute('deleteAt', now), ...customAttributions.map(attr => Y.createContentAttribute('delete:' + attr.k, attr.v))]
  ))
}

/**
 * @param {string|undefined} param
 * @returns {Array<{k: string, v: string}>}
 */
const parseCustomAttributionsParam = (param) =>
  param ? param.split(',').map(entry => { const [k, ...rest] = entry.split(':'); return { k, v: rest.join(':') } }) : []

/**
 * @param {uws.HttpRequest} req
 */
const reqToRoom = req => {
  const org = /** @type {string} */ (req.getParameter(0))
  const docid = /** @type {string} */ (req.getParameter(1))
  const branch = /** @type {string} */ (req.getQuery('branch')) ?? 'main'
  return { org, docid, branch }
}

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
    res.writeHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
    res.writeHeader('Access-Control-Allow-Headers', 'Content-Type')
  }

  /**
   * @param {uws.HttpResponse} res
   * @param {string} status
   * @param {{ error: string }} body
   */
  const sendErrorResponse = (res, status, body) => {
    const encoder = encoding.createEncoder()
    encoding.writeAny(encoder, body)
    const response = encoding.toUint8Array(encoder)
    res.cork(() => {
      setCorsHeaders(res)
      res.writeStatus(status)
      res.writeHeader('Content-Type', 'application/octet-stream')
      res.end(response)
    })
  }

  /**
   * @param {uws.HttpRequest} req
   * @param {t.Room} room
   * @param {'r' | 'rw'} requiredAccess
   * @returns {Promise<{ authInfo: { userid: string }, accessType: t.AccessType } | { error: string, status: string }>}
   */
  const authenticateRequest = async (req, room, requiredAccess) => {
    // If no auth module is defined, no auth is required
    if (yhub.conf.server?.auth == null) {
      return { authInfo: { userid: 'anonymous' }, accessType: 'rw' }
    }
    try {
      const authInfo = await yhub.conf.server.auth.readAuthInfo(req)
      if (authInfo == null) {
        return { error: 'Unauthorized', status: '401 Unauthorized' }
      }
      const accessType = await yhub.conf.server.auth.getAccessType(authInfo, room)
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

  // Handle CORS preflight requests
  app.options('/*', (res, _req) => {
    res.cork(() => {
      setCorsHeaders(res)
      res.writeStatus('204 No Content')
      res.end()
    })
  })

  // GET /ydoc/{org}/{docid} - Retrieve the Yjs document
  app.get('/ydoc/:org/:docid', async (res, req) => {
    const room = reqToRoom(req)
    const gc = req.getQuery('gc') !== 'false'
    log.debug({ endpoint: 'GET /ydoc', room }, 'api request')
    let aborted = false
    res.onAborted(() => {
      aborted = true
    })
    const authResult = await authenticateRequest(req, room, 'r')
    if ('error' in authResult) {
      if (!aborted) sendErrorResponse(res, authResult.status, { error: authResult.error })
      return
    }
    try {
      const { gcDoc, nongcDoc } = await yhub.getDoc(room, { gc, nongc: !gc }, { gcOnMerge: false })
      const ydoc = gcDoc || nongcDoc || Y.encodeStateAsUpdate(new Y.Doc())
      if (aborted) return
      const encoder = encoding.createEncoder()
      encoding.writeAny(encoder, { doc: ydoc })
      const response = encoding.toUint8Array(encoder)
      res.cork(() => {
        setCorsHeaders(res)
        res.writeStatus('200 OK')
        res.writeHeader('Content-Type', 'application/octet-stream')
        res.end(response)
      })
    } catch (err) {
      log.error({ err, room }, 'error handling ydoc request')
      if (aborted) return
      sendErrorResponse(res, '500 Internal Server Error', { error: 'Failed to retrieve document' })
    }
  })

  // PATCH /ydoc/{org}/{docid} - Update the Yjs document
  app.patch('/ydoc/:org/:docid', (res, req) => {
    const room = reqToRoom(req)
    log.debug({ endpoint: 'PATCH /ydoc', room }, 'api request')
    const authPromise = authenticateRequest(req, room, 'rw')
    let buffer = Buffer.allocUnsafe(0)
    let aborted = false
    res.onAborted(() => {
      aborted = true
    })
    /**
     * @param {Buffer} buffer
     */
    const handleUpdateRequest = async buffer => {
      const authResult = await authPromise
      if (aborted) return
      if ('error' in authResult) {
        sendErrorResponse(res, authResult.status, { error: authResult.error })
        return
      }
      try {
        const decoder = decoding.createDecoder(buffer)
        const decodedBody = decoding.readAny(decoder)
        if (s.$object({ update: s.$uint8Array, customAttributions: s.$array(s.$object({ k: s.$string, v: s.$string })).optional }).check(decodedBody)) {
          const { update, customAttributions = [] } = decodedBody
          // Get current document state to diff against
          const { gcDoc, nongcDoc } = await yhub.getDoc(room, { gc: true, nongc: false }, { gcOnMerge: false })
          const currentDoc = gcDoc || nongcDoc || Y.encodeStateAsUpdate(new Y.Doc())
          const result = await yhub.computePool.patchYdoc({
            update,
            currentDoc,
            userid: authResult.authInfo.userid,
            customAttributions
          }, { room })
          if (result != null) {
            await yhub.stream.addMessage(room, { type: 'ydoc:update:v1', contentmap: result.contentmap, update: result.update })
          }
          if (!aborted) {
            const encoder = encoding.createEncoder()
            encoding.writeAny(encoder, { success: true, message: 'Document updated' })
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
      } catch (_err) {
        log.warn({ err: _err }, 'error parsing update request')
      }
      if (!aborted) {
        sendErrorResponse(res, '400 Bad Request', { error: 'Invalid request body' })
      }
    }
    res.onData((chunk, isLast) => {
      const chunkBuffer = Buffer.from(chunk)
      buffer = Buffer.concat([buffer, chunkBuffer])
      if (isLast) {
        handleUpdateRequest(buffer).catch(err => {
          log.error({ err }, 'error handling update request')
          if (!aborted) sendErrorResponse(res, '500 Internal Server Error', { error: 'Internal server error' })
        })
      }
    })
  })

  // POST /rollback/{guid} - Rollback changes matching the pattern
  app.post('/rollback/:org/:docid', (res, req) => {
    const room = reqToRoom(req)
    log.debug({ endpoint: 'POST /rollback', room }, 'api request')
    const authPromise = authenticateRequest(req, room, 'rw')
    let buffer = Buffer.allocUnsafe(0)
    let aborted = false
    res.onAborted(() => {
      aborted = true
    })
    /**
     * @param {Buffer} buffer
     */
    const handleRollbackRequest = async buffer => {
      const authResult = await authPromise
      if (aborted) return
      if ('error' in authResult) {
        sendErrorResponse(res, authResult.status, { error: authResult.error })
        return
      }
      try {
        const decoder = decoding.createDecoder(buffer)
        // body structure: { from?: number, to?: number, by?: string, contentIds?: buffer }
        const decodedBody = decoding.readAny(decoder)
        if (s.$object({ from: s.$number.optional, to: s.$number.optional, by: s.$string.optional, contentIds: s.$uint8Array.optional, customAttributions: s.$array(s.$object({ k: s.$string, v: s.$string })).optional, withCustomAttributions: s.$array(s.$object({ k: s.$string, v: s.$string })).optional }).check(decodedBody)) {
          const { from, to, by, contentIds: contentIdsBin, customAttributions = [], withCustomAttributions = null } = decodedBody
          if (!from && !to && !by && !contentIdsBin && (withCustomAttributions ?? []).length === 0) {
            !aborted && sendErrorResponse(res, '400 Bad Request', { error: 'Rollback requires at least one filter (from, to, by, contentIds, or withCustomAttributions)' })
            return
          }
          const { contentmap: contentmapBin, nongcDoc } = await yhub.getDoc(room, { nongc: true, contentmap: true })
          const { update, contentmap } = await yhub.computePool.rollback({
            nongcDoc,
            contentmapBin,
            from,
            to,
            by,
            contentIds: contentIdsBin,
            withCustomAttributions,
            userid: authResult.authInfo.userid,
            customAttributions
          }, { room })
          if (update) {
            await yhub.stream.addMessage(room, {
              type: 'ydoc:update:v1',
              update,
              contentmap
            })
          }
          if (!aborted) {
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
      } catch (err) {
        log.warn({ err }, 'error parsing rollback request')
      }
      if (!aborted) {
        sendErrorResponse(res, '400 Bad Request', { error: 'error consuming request' })
      }
    }
    res.onData((chunk, isLast) => {
      const chunkBuffer = Buffer.from(chunk)
      buffer = Buffer.concat([buffer, chunkBuffer])
      if (isLast) {
        handleRollbackRequest(buffer).catch(err => {
          log.error({ err }, 'error handling rollback request')
          if (!aborted) sendErrorResponse(res, '500 Internal Server Error', { error: 'Internal server error' })
        })
      }
    })
  })

  // GET /changeset/{guid} - Get attributed changes and document states
  app.get('/changeset/:org/:docid', async (res, req) => {
    const room = reqToRoom(req)
    log.debug({ endpoint: 'GET /changeset', room }, 'api request')
    const by = req.getQuery('by')
    const _from = req.getQuery('from')
    const _to = req.getQuery('to')
    const from = _from == null ? null : number.parseInt(_from)
    const to = _to == null ? null : number.parseInt(_to)
    const includeYdoc = req.getQuery('ydoc') === 'true'
    const includeDelta = req.getQuery('delta') === 'true'
    const includeAttributions = req.getQuery('attributions') === 'true'
    const withCustomAttributionsParam = req.getQuery('withCustomAttributions')
    /** @type {Array<{k: string, v: string}>|null} */
    const withCustomAttributions = withCustomAttributionsParam ? parseCustomAttributionsParam(withCustomAttributionsParam) : null
    let aborted = false
    res.onAborted(() => {
      aborted = true
      log.debug('request aborted')
    })
    const authResult = await authenticateRequest(req, room, 'r')
    if ('error' in authResult) {
      if (!aborted) sendErrorResponse(res, authResult.status, { error: authResult.error })
      return
    }
    try {
      const cacheArgs = [room.org, room.docid, room.branch, String(from), String(to), by || '', String(includeYdoc), String(includeDelta), String(includeAttributions), withCustomAttributionsParam || '']
      const responseData = await yhub.stream.cachedGet('changeset', cacheArgs, async () => {
        const { nongcDoc, contentmap: contentmapBin } = await yhub.getDoc(room, { nongc: true, contentmap: true })
        return yhub.computePool.changeset({
          nongcDoc,
          contentmapBin,
          from,
          to,
          by: by || '',
          withCustomAttributions,
          includeYdoc,
          includeDelta,
          includeAttributions
        }, { room })
      })
      if (!aborted) {
        res.cork(() => {
          setCorsHeaders(res)
          res.writeStatus('200 OK')
          res.writeHeader('Content-Type', 'application/octet-stream')
          res.end(responseData)
        })
      }
    } catch (err) {
      log.error({ err, room }, 'error handling changeset request')
      if (!aborted) sendErrorResponse(res, '500 Internal Server Error', { error: 'Failed to compute changeset' })
    }
  })

  // GET /activity/{guid} - Get all editing timestamps for a document
  app.get('/activity/:org/:docid', async (res, req) => {
    const room = reqToRoom(req)
    log.debug({ endpoint: 'GET /activity', room }, 'api request')
    const by = req.getQuery('by')
    const from = number.parseInt(req.getQuery('from') || '0')
    const to = number.parseInt(req.getQuery('to') || number.MAX_SAFE_INTEGER.toString())
    const includeDelta = req.getQuery('delta') === 'true'
    const limit = number.parseInt(req.getQuery('limit') || number.MAX_SAFE_INTEGER.toString())
    const reverse = req.getQuery('order') === 'desc'
    const group = req.getQuery('group') !== 'false'
    const withCustomAttributionsParam = req.getQuery('withCustomAttributions')
    /** @type {Array<{k: string, v: string}>|null} */
    const withCustomAttributions = withCustomAttributionsParam ? parseCustomAttributionsParam(withCustomAttributionsParam) : null
    const includeCustomAttributions = req.getQuery('customAttributions') === 'true'
    const contentIdsParam = req.getQuery('contentIds')
    const contentIdsBin = contentIdsParam ? buffer.fromBase64(contentIdsParam) : undefined
    let aborted = false
    res.onAborted(() => {
      aborted = true
      log.debug('request aborted')
    })
    const authResult = await authenticateRequest(req, room, 'r')
    if ('error' in authResult) {
      if (!aborted) sendErrorResponse(res, authResult.status, { error: authResult.error })
      return
    }
    try {
      const cacheArgs = [room.org, room.docid, room.branch, String(from), String(to), by || '', String(includeDelta), String(limit), reverse ? 'desc' : 'asc', String(group), withCustomAttributionsParam || '', String(includeCustomAttributions), contentIdsParam || '']
      const responseData = await yhub.stream.cachedGet('activity', cacheArgs, async () => {
        const { contentmap: contentmapBin, nongcDoc } = await yhub.getDoc(room, { nongc: true, contentmap: true })
        return yhub.computePool.activity({
          nongcDoc,
          contentmapBin,
          from,
          to,
          by: by || '',
          contentIds: contentIdsBin,
          withCustomAttributions,
          includeCustomAttributions,
          includeDelta,
          limit,
          reverse,
          group
        }, { room })
      })
      if (!aborted) {
        res.cork(() => {
          setCorsHeaders(res)
          res.writeStatus('200 OK')
          res.writeHeader('Content-Type', 'application/octet-stream')
          res.end(responseData)
        })
      }
    } catch (err) {
      log.error({ err, room }, 'error handling activity request')
      if (!aborted) sendErrorResponse(res, '500 Internal Server Error', { error: 'Failed to compute activity' })
    }
  })

  await promise.create((resolve, reject) => {
    const port = conf.server?.port || 4000
    app.listen(port, (token) => {
      if (token) {
        log.info({ port }, 'listening')
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
   * @param {uws.WebSocket<{ user: WSUser }>|null} ws
   * @param {t.Room} room
   * @param {boolean} hasWriteAccess
   * @param {{ userid: string }} authInfo
   * @param {boolean} gc
   * @param {Array<{ k: string, v: string }>} customAttributions
   */
  constructor (yhub, ws, room, hasWriteAccess, authInfo, gc, customAttributions) {
    this.yhub = yhub
    /**
     * @type {uws.WebSocket<{ user: WSUser }>|null}
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
    this.customAttributions = customAttributions
    /**
     * @type {number|null}
     */
    this.awarenessId = null
    this.awarenessLastClock = 0
    this.isClosed = false
    this.isDestroyed = false
    this.lastReceivedClock = '0'
    this.log = log.child({ clientId: this.id, userid: this.userid, gc, hasWriteAccess, room })
  }

  /**
   * @param {t.Room} _room
   * @param {Array<t.Message>} ms
   */
  onStreamMessage (_room, ms) {
    if (ms.length > 0) {
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
            this.log.error('unexpected message type on stream: ' + /** @type {any} */ (message).type)
          }
        }
      })
      this.sendData(encoding.toUint8Array(encoder))
    }
  }

  /**
   * @param {Uint8Array<ArrayBuffer>} m
   */
  sendData (m) {
    if (this.ws == null) {
      return this.log.warn('tried to send a message to client, but it is not connected yet')
    }
    this.log.debug({ size: m.byteLength, firstByte: m[0] }, 'sending data to client')
    const sendResult = this.ws.send(m, true, false)
    if (sendResult === 2) {
      this.log.error({ socketBackpressure: this.ws?.getBufferedAmount(), maxDocSize: this.yhub.conf.server?.maxDocSize }, 'message dropped because of backpressure limit')
      this.closeWithError(400, 'closing because of backpressure limit')
    }
  }

  /**
   * @param {number} code
   * @param {string} message
   */
  closeWithError (code, message) {
    this.log.error({ code, message }, 'closing connection with error')
    if (!this.isClosed) {
      this.ws?.end(code, message)
      this.isClosed = true
    }
    this.destroy()
  }

  destroy () {
    if (!this.isDestroyed) {
      this.isDestroyed = true
      this.yhub.stream.unsubscribe(this.room, this)
      this.awarenessId && this.yhub.stream.addMessage(this.room, { type: 'awareness:v1', update: protocol.encodeAwarenessUserDisconnected(this.awarenessId, this.awarenessLastClock) }).catch(err => {
        this.log.error({ err }, 'error adding message to redis')
      })
      if (!this.isClosed) {
        this.ws?.close()
      }
    }
  }
}

/**
 * @param {import('./index.js').YHub} yhub
 * @param {uws.TemplatedApp} app
 */
const registerWebsocketServer = (yhub, app) => {
  const maxDocSize = s.$number.cast(yhub.conf.server?.maxDocSize)
  app.ws('/ws/:org/:docid', /** @type {uws.WebSocketBehavior<{ user: WSUser }>} */ ({
    compression: uws.DISABLED,
    maxPayloadLength: maxDocSize,
    maxBackpressure: math.round(maxDocSize * 1.2),
    closeOnBackpressureLimit: true,
    idleTimeout: 120,
    sendPingsAutomatically: true,
    upgrade: async (res, req, context) => {
      const url = req.getUrl()
      const headerWsKey = req.getHeader('sec-websocket-key')
      const headerWsProtocol = req.getHeader('sec-websocket-protocol')
      const headerWsExtensions = req.getHeader('sec-websocket-extensions')
      let aborted = false
      res.onAborted(() => {
        log.debug({ url }, 'upgrading client aborted')
        aborted = true
      })
      try {
        const room = reqToRoom(req)
        const gc = req.getQuery('gc') !== 'false' // default to true unless explicitly set to 'false'
        const customAttributionsParam = req.getQuery('customAttributions')
        /** @type {Array<{k: string, v: string}>} */
        const customAttributions = parseCustomAttributionsParam(customAttributionsParam)
        const authInfo = await yhub.conf.server?.auth.readAuthInfo(req)
        s.$string.expect(authInfo.userid)
        const accessType = authInfo && await yhub.conf.server?.auth.getAccessType(authInfo, room)
        if (authInfo == null || !t.hasReadAccess(accessType)) {
          log.info({ url, userid: authInfo?.userid ?? null }, 'ws upgrade denied, insufficient access')
          res.cork(() => {
            res.writeStatus('401 Unauthorized').end('Unauthorized')
          })
          return
        }
        if (aborted) return
        res.cork(() => {
          res.upgrade(
            { user: new WSUser(yhub, null, room, t.hasWriteAccess(accessType), authInfo, gc, customAttributions) },
            headerWsKey,
            headerWsProtocol,
            headerWsExtensions,
            context
          )
        })
      } catch (err) {
        log.warn({ url, err }, 'user failed to auth')
        if (aborted) return
        res.cork(() => {
          res.writeStatus('401 Unauthorized').end('Unauthorized')
        })
      }
    },
    open: async (ws) => {
      const user = ws.getUserData().user
      user.ws = ws
      user.log.info({ ip: Buffer.from(ws.getRemoteAddressAsText()).toString() }, 'client connected')
      try {
        const doctable = await yhub.getDoc(user.room, { gc: user.gc, nongc: !user.gc, awareness: true }, { gcOnMerge: false })
        const ydoc = doctable.gcDoc || doctable.nongcDoc || Y.encodeStateAsUpdate(new Y.Doc())
        if (user.isClosed) return
        ws.cork(() => {
          user.sendData(protocol.encodeSyncStep1(Y.encodeStateVectorFromUpdate(ydoc)))
          user.sendData(protocol.encodeSyncStep2(ydoc))
          user.log.debug('sent syncstep2 to client')
          const aw = doctable.awareness
          if (aw.byteLength > 3) {
            user.sendData(aw)
          }
        })
        user.lastReceivedClock = doctable.lastClock
        yhub.stream.subscribe(user.room, user)
      } catch (err) {
        user.log.error({ err }, 'failed to sync initial document')
        user.closeWithError(1011, 'Internal error')
      }
    },
    message: (ws, messageBuffer) => {
      const user = ws.getUserData().user
      /**
       * @param {any} err
       */
      const handleErr = err => {
        user.log.error({ err }, 'error processing client message')
        user.closeWithError(1011, 'Internal error')
      }
      // don't read any messages from users without write access
      if (!user.hasWriteAccess) return
      try {
        // It is important to copy the data here
        const message = Buffer.from(messageBuffer.slice(0, messageBuffer.byteLength))
        const decoder = decoding.createDecoder(message)
        switch (decoding.readVarUint(decoder)) {
          case 0: { // sync message
            const syncMessageType = decoding.readVarUint(decoder)
            if (syncMessageType === protocol.messageSyncUpdate || syncMessageType === protocol.messageSyncStep2) {
              const update = decoding.readVarUint8Array(decoder)
              if (update.byteLength > 3) {
                const contentmap = createContentMapFromParams(Y.createContentIdsFromUpdate(update), user.userid, user.customAttributions)
                yhub.stream.addMessage(user.room, { type: 'ydoc:update:v1', contentmap, update }).catch(handleErr)
              }
            } else if (syncMessageType === protocol.messageSyncStep1) {
              // can be safely ignored because we send the full initial state at the beginning
            } else {
              user.log.warn({ syncMessageType }, 'unknown sync message type')
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
            yhub.stream.addMessage(user.room, { type: 'awareness:v1', update }).catch(handleErr)
            break
          }
        }
      } catch (err) {
        handleErr(err)
      }
    },
    close: (ws, code, message) => {
      const user = ws.getUserData().user
      user.isClosed = true
      user.log.info({ code, message: Buffer.from(message).toString() }, 'client connection closed')
      user.destroy()
    }
  }))
}
