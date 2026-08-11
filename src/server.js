import * as uws from 'uws'
import * as error from 'lib0/error'
import * as decoding from 'lib0/decoding'
import * as f from 'lib0/function'
import * as object from 'lib0/object'
import * as promise from 'lib0/promise'
import * as Y from '@y/y'
import * as s from 'lib0/schema'
import * as time from 'lib0/time'
import * as t from './types.js'
import * as protocol from './protocol.js'
import * as math from 'lib0/math'
import { mergeUpdates } from './y-utils.js'
import { registerApi, resolveApiPrefix, isApiError, statusLine } from './api.js'
import { parseCustomAttributionsParam } from './builtin-api.js'
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
 * @param {uws.HttpRequest} req
 */
const reqToRoom = req => {
  const org = /** @type {string} */ (req.getParameter(0))
  const docid = /** @type {string} */ (req.getParameter(1))
  const branch = /** @type {string} */ (req.getQuery('branch')) ?? 'main'
  return { org, docid, branch }
}

/**
 * Close code sent when a connection is disconnected because its permissions changed (see
 * `YHub.recheckAuth`). 4000-4999 is the websocket application range.
 *
 * Close codes encode retry semantics (see the Errors section in API.md): 4400-4499 are
 * permanent yhub errors - don't reconnect until the app acts - and 4500-4599 are reserved for
 * transient yhub errors. Where a standard code fits, it is preferred: 1011 internal error and
 * 1013 try again later, both transient.
 */
export const wsCloseAuthRevoked = 4401

/**
 * Close code sent when the document was deleted (see `YHub.deleteDoc`). Permanent (4400-4499):
 * the document is not coming back and a reconnect is refused at sync time anyway, so a client
 * should stop reconnecting and drop its local copy.
 */
export const wsCloseDocDeleted = 4404

/**
 * Matcher semantics of `YHub.recheckAuth`: a string matcher matches connections with that
 * `userid`; a plain-object matcher matches when each of its top-level properties deep-equals
 * the corresponding authInfo property (the authInfo may have additional properties).
 *
 * @param {string|Object<string,any>} matcher
 * @param {{ userid: string }} authInfo
 */
export const matchesAuthInfo = (matcher, authInfo) => s.$primitive.check(matcher)
  ? authInfo.userid === matcher
  : object.every(matcher, (v, k) => f.equalityDeep(v, /** @type {any} */ (authInfo)[k]))

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
  // resolve once, before any route registration - an invalid prefix fails fast
  const prefix = resolveApiPrefix(yhub)
  registerWebsocketServer(yhub, app, prefix)

  // Handle CORS preflight requests
  app.options('/*', (res, req) => {
    // reflect the requested headers so custom request headers pass the preflight
    const requestedHeaders = req.getHeader('access-control-request-headers')
    res.cork(() => {
      // the status must be written before any header - otherwise uws locks the status to "200 OK"
      res.writeStatus('204 No Content')
      res.writeHeader('Access-Control-Allow-Origin', '*')
      res.writeHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      res.writeHeader('Access-Control-Allow-Headers', requestedHeaders !== '' ? requestedHeaders : 'Content-Type, Authorization')
      res.end()
    })
  })

  // built-in + custom rest endpoints - served under `/{apiPrefix}/{name}/{version}/...`
  registerApi(yhub, app)

  await promise.create((resolve, reject) => {
    const port = conf.server?.port || 4400
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
      /** @type {Array<Uint8Array<ArrayBuffer>>} */
      const ydocUpdates = []
      /** @type {Array<Uint8Array<ArrayBuffer>>} */
      const awarenessUpdates = []
      ms.forEach(message => {
        switch (message.type) {
          case 'ydoc:update:v1': {
            ydocUpdates.push(message.update)
            break
          }
          case 'awareness:v1': {
            awarenessUpdates.push(message.update)
            break
          }
          case 'prune:v1': {
            // history-pruning directive: affects persisted history only, nothing to relay to clients
            break
          }
          case 'ydoc:tombstone:v1': {
            this.log.info('document deleted, disconnecting')
            this.closeDocDeleted()
            break
          }
          case 'auth:check:v1': {
            if (message.users == null || message.users.some(u => matchesAuthInfo(u, this.authInfo))) {
              if (message.forceDisconnect) {
                this.log.info('force disconnect requested')
                this.close(wsCloseAuthRevoked, 'permission revoked')
              } else {
                this.recheckAuth()
              }
            }
            break
          }
          default: {
            this.log.error('unexpected message type on stream: ' + /** @type {any} */ (message).type)
          }
        }
      })
      // @todo send this as a single update message
      if (ydocUpdates.length > 0) {
        this.sendData(protocol.encodeSyncUpdate(mergeUpdates(false, ydocUpdates)))
      }
      if (awarenessUpdates.length > 0) {
        this.sendData(protocol.mergeAwarenessUpdates(awarenessUpdates))
      }
    }
  }

  /**
   * @param {Uint8Array<ArrayBuffer>} m
   */
  sendData (m) {
    if (this.isClosed) return
    if (this.ws == null) {
      return this.log.warn('tried to send a message to client, but it is not connected yet')
    }
    this.log.debug({ size: m.byteLength, firstByte: m[0] }, 'sending data to client')
    const sendResult = this.ws.send(m, true, false)
    if (sendResult === 2) {
      this.log.error({ socketBackpressure: this.ws?.getBufferedAmount(), maxDocSize: this.yhub.conf.server?.maxDocSize }, 'message dropped because of backpressure limit')
      this.closeWithError(1013, 'closing because of backpressure limit')
    }
  }

  /**
   * Re-evaluate this connection's access via the auth plugin (see `YHub.recheckAuth`).
   * Disconnects when the access type changed — the client reconnects, re-authenticates, and
   * resyncs at its new access level (updating `hasWriteAccess` in place would silently drop
   * a downgraded client's updates and diverge it from the server). Fails closed: an auth
   * plugin error also disconnects, but with the transient code 1013 instead of 4401 — the
   * client keeps reconnecting and is re-checked at upgrade, so it recovers once the auth
   * backend does.
   */
  async recheckAuth () {
    try {
      const accessType = await this.yhub.conf.server?.auth.getAccessType(this.authInfo, this.room, null)
      if (this.isDestroyed) return
      if (!t.hasReadAccess(accessType) || t.hasWriteAccess(accessType) !== this.hasWriteAccess) {
        this.log.info({ accessType }, 'access changed, disconnecting')
        this.close(wsCloseAuthRevoked, 'permission revoked')
      }
    } catch (err) {
      this.log.warn({ err }, 'auth recheck failed, disconnecting')
      this.close(1013, 'auth recheck failed')
    }
  }

  /**
   * @param {number} code
   * @param {string} message
   */
  close (code, message) {
    if (!this.isClosed) {
      this.ws?.end(code, message)
      this.isClosed = true
    }
    this.destroy()
  }

  /**
   * Disconnect because the document was deleted. Drops `awarenessId` first: `destroy` would
   * otherwise announce this client's awareness departure, and that write would re-create the
   * stream key the deletion just cleared and enqueue another compact task for a dead room.
   */
  closeDocDeleted () {
    this.awarenessId = null
    this.close(wsCloseDocDeleted, 'document deleted')
  }

  /**
   * @param {number} code
   * @param {string} message
   */
  closeWithError (code, message) {
    this.log.error({ code, message }, 'closing connection with error')
    this.close(code, message)
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
 * @param {string} prefix
 */
const registerWebsocketServer = (yhub, app, prefix) => {
  const maxDocSize = s.$number.cast(yhub.conf.server?.maxDocSize)
  app.ws(`/${prefix}/ws/v1/:org/:docid`, /** @type {uws.WebSocketBehavior<{ user: WSUser }>} */ ({
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
        const accessType = authInfo && await yhub.conf.server?.auth.getAccessType(authInfo, room, null)
        if (!t.hasReadAccess(accessType)) {
          log.info({ url, userid: authInfo?.userid ?? null }, 'ws upgrade denied, insufficient access')
          res.cork(() => {
            res.writeStatus('403 Forbidden').end('Forbidden')
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
          // a branded apiError (e.g. apiError(503, ...)) lets the auth plugin signal a
          // temporary auth-backend outage instead of the fail-closed 401
          if (isApiError(err)) {
            res.writeStatus(statusLine(err.status)).end(err.message)
          } else {
            res.writeStatus('401 Unauthorized').end('Unauthorized')
          }
        })
      }
    },
    open: async (ws) => {
      const user = ws.getUserData().user
      user.ws = ws
      user.log.info({ ip: Buffer.from(ws.getRemoteAddressAsText()).toString() }, 'client connected')
      try {
        const doctable = await yhub.getDoc(user.room, { gc: user.gc, nongc: !user.gc, awareness: true }, { gcOnMerge: false })
        // also the upgrade-time check: a reconnecting client is refused here, and so is one whose
        // document was deleted between the upgrade and this initial sync - a window the stream
        // cannot cover, because `lastReceivedClock` is only set below
        if (doctable.tombstone != null) {
          user.log.info('document deleted, refusing to sync')
          user.closeDocDeleted()
          return
        }
        const ydoc = doctable.gcDoc || doctable.nongcDoc || Y.encodeStateAsUpdate(new Y.Doc())
        const sv = await yhub.computePool.computeStateVector(ydoc, { room: user.room })
        // the initial `lastReceivedClock` (below) is past any pending auth:check entry, so a
        // check added between the upgrade's auth check and the stream read above would be
        // silently consumed - re-check once here instead. `forceDisconnect` entries are
        // deliberately replayed as a plain re-check: kicking on replay would loop a
        // legitimately re-authorized user until the entry ages out of the stream.
        if (doctable.authChecks.some(m => m.users == null || m.users.some(u => matchesAuthInfo(u, user.authInfo)))) {
          await user.recheckAuth()
        }
        if (user.isClosed) return
        ws.cork(() => {
          user.sendData(protocol.encodeSyncStep1(sv))
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
