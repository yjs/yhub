import * as uws from 'uws'
import * as error from 'lib0/error'
import * as decoding from 'lib0/decoding'
import * as f from 'lib0/function'
import * as object from 'lib0/object'
import * as promise from 'lib0/promise'
import * as Y from '@y/y'
import * as s from 'lib0/schema'
import * as time from 'lib0/time'
import * as protocol from './protocol.js'
import * as math from 'lib0/math'
import { mergeUpdates } from './y-utils.js'
import { registerApi, resolveApiPrefix, resolvePermissions, normalizeAuthorizeAnswer, apiError, isApiError, statusLine } from './api.js'
import { originAllowed, resolveCors } from './cors.js'
import { parseCustomAttributionsParam } from './builtin-api.js'
import { endpointPermission } from './permissions.js'
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
const reqToDocRef = req => {
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
 * the corresponding authInfo property (the authInfo may have additional properties). Anonymous
 * connections (`authInfo === null`) are matched only by the empty object matcher.
 *
 * @param {string|Object<string,any>} matcher
 * @param {{ userid: string }|null} authInfo
 */
export const matchesAuthInfo = (matcher, authInfo) => s.$primitive.check(matcher)
  ? authInfo?.userid === matcher
  : object.every(matcher, (v, k) => f.equalityDeep(v, /** @type {any} */ (authInfo)?.[k]))

export class YHubServer {
  /**
   * @param {import('./index.js').YHub} yhub
   * @param {import('./types.js').YHubConfig} conf
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
 * @param {import('./types.js').YHubConfig} conf
 */
export const createYHubServer = async (yhub, conf) => {
  const app = uws.App({})
  const yhubServer = new YHubServer(yhub, conf, app)
  yhub.server = yhubServer
  // resolve once, before any route registration - an invalid prefix or cors config fails fast
  const prefix = resolveApiPrefix(yhub)
  const cors = resolveCors(conf.server?.cors, undefined)
  if (cors?.originAll === true) {
    log.warn('cors.origin is "*" - the api and websockets are open to every origin: any site can act in a logged-in visitor\'s session if the auth plugin reads ambient credentials (cookies). Use an allowlist in production.')
  }
  registerWebsocketServer(yhub, app, prefix, cors)

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
   * @param {import('./types.js').DocRef} docRef
   * @param {import('./permissions.js').DocumentPermissionsV1Normalized} permissions
   * @param {{ userid: string }|null} authInfo - null for an anonymous connection
   * @param {boolean} gc
   * @param {Array<{ k: string, v: string }>} customAttributions
   */
  constructor (yhub, ws, docRef, permissions, authInfo, gc, customAttributions) {
    this.yhub = yhub
    /**
     * @type {uws.WebSocket<{ user: WSUser }>|null}
     */
    this.ws = ws
    this.docRef = docRef
    /**
     * The normalized permissions this connection was authorized with. Frozen for the lifetime
     * of the connection except through `recheckAuth`, which replaces the whole object.
     */
    this.permissions = permissions
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
     * Identifies the User globally - null for an anonymous connection, which never holds ydoc
     * `u` (attributions carry the userid; see the upgrade handler).
     * Note that several clients can have the same userid (e.g. if a user opened several browser
     * windows)
     */
    this.userid = authInfo?.userid ?? null
    this.customAttributions = customAttributions
    /**
     * @type {number|null}
     */
    this.awarenessId = null
    this.awarenessLastClock = 0
    this.isClosed = false
    this.isDestroyed = false
    this.lastReceivedClock = '0'
    this.log = log.child({ clientId: this.id, userid: this.userid, gc, ydoc: permissions.ydoc, awareness: permissions.awareness, ws: endpointPermission(permissions, 'ws'), docRef })
  }

  /**
   * @param {import('./types.js').DocRef} _docRef
   * @param {Array<import('./types.js').Message>} ms
   */
  onStreamMessage (_docRef, ms) {
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
      // presence is relayed only when this connection may receive it (ydoc fan-out needs no
      // gate: ydoc read is an upgrade invariant, maintained by recheckAuth)
      if (awarenessUpdates.length > 0 && this.permissions.awareness[1] === 'r') {
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
   * Re-evaluate this connection's permissions via the auth plugin (see `YHub.recheckAuth`) and
   * compare the leaves the socket consumes: the `ydoc` mask, the `awareness` mask, the effective
   * `ws` endpoint mask, and - for `gc=false` connections - whether full history is still granted
   * (the nongc doc *is* the full history). Any difference disconnects, downgrades and upgrades
   * alike - the client reconnects, re-authenticates, and resyncs at its new access level
   * (updating the gates in place would silently drop a downgraded client's updates and diverge
   * it from the server). REST-only facets (`delete`, `history.rollback`/`prune`, the other
   * `endpoint` entries) never bounce a live connection. Fails closed: an auth plugin error also
   * disconnects, but with the transient code 1013 instead of 4401 - the client keeps
   * reconnecting and is re-checked at upgrade, so it recovers once the auth backend does.
   */
  async recheckAuth () {
    try {
      const answer = await this.yhub.conf.server?.auth.authorize('document', this.docRef, this.authInfo)
      if (this.isDestroyed) return
      const p = normalizeAuthorizeAnswer('document', answer)
      const cur = this.permissions
      if (p === null || p.ydoc !== cur.ydoc || p.awareness !== cur.awareness || endpointPermission(p, 'ws') !== endpointPermission(cur, 'ws') || (!this.gc && !(p.history !== false && p.history.from === 0))) {
        this.log.info({ ydoc: p?.ydoc, awareness: p?.awareness, ws: p && endpointPermission(p, 'ws') }, 'permissions changed, disconnecting')
        this.close(wsCloseAuthRevoked, 'permission revoked')
      } else {
        this.permissions = p
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
   * stream key the deletion just cleared and enqueue another compact task for a dead document.
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
      this.yhub.stream.unsubscribe(this.docRef, this)
      this.awarenessId && this.yhub.stream.addMessage(this.docRef, { type: 'awareness:v1', update: protocol.encodeAwarenessUserDisconnected(this.awarenessId, this.awarenessLastClock) }).catch(err => {
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
 * @param {import('./cors.js').ResolvedCors|null} cors
 */
const registerWebsocketServer = (yhub, app, prefix, cors) => {
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
      const origin = req.getHeader('origin')
      const host = req.getHeader('host')
      const secFetchSite = req.getHeader('sec-fetch-site')
      const headerWsKey = req.getHeader('sec-websocket-key')
      const headerWsProtocol = req.getHeader('sec-websocket-protocol')
      const headerWsExtensions = req.getHeader('sec-websocket-extensions')
      let aborted = false
      res.onAborted(() => {
        log.debug({ url }, 'upgrading client aborted')
        aborted = true
      })
      // denials are thrown as branded apiErrors and written by the catch below - `extra` carries
      // the log context, since an upgrade denial has no body to serialize it into
      try {
        // browsers don't enforce cors on websockets - any page may open one - so the origin is
        // checked here explicitly: cross-origin is denied unless cors allows it, same-origin
        // passes (see originAllowed). Clients that send no `Origin` (node, server-to-server)
        // are never restricted; the auth plugin gates those.
        if (!originAllowed(cors, origin, host, secFetchSite)) throw apiError(403, 'origin not allowed', { origin, host })
        const docRef = reqToDocRef(req)
        const gc = req.getQuery('gc') !== 'false' // default to true unless explicitly set to 'false'
        const customAttributions = parseCustomAttributionsParam(req.getQuery('customAttributions'))
        const { authInfo, permissions } = await resolvePermissions(yhub, req, 'document', docRef)
        const userid = authInfo?.userid ?? null
        // the websocket route is the endpoint named `ws`: its `r` opens the socket, its `u`
        // (with ydoc `u`) admits doc updates - see the `message` handler
        if (permissions === null || permissions.ydoc[1] !== 'r' || endpointPermission(permissions, 'ws')[1] !== 'r') throw apiError(403, 'insufficient access', { userid })
        // attributions carry the userid: an anonymous caller may hold the write but cannot use
        // it, and a socket that could never write is refused up front - authenticate, then reconnect
        if (authInfo == null && permissions.ydoc[2] === 'u' && endpointPermission(permissions, 'ws')[2] === 'u') throw apiError(401, 'unauthenticated')
        // the nongc doc *is* the full history - a bounded history ray is unenforceable on it, so
        // gc=false demands the full ray explicitly rather than silently downgrading to gc=true
        if (!gc && !(permissions.history !== false && permissions.history.from === 0)) throw apiError(403, 'gc=false requires full history access', { userid })
        if (aborted) return
        res.cork(() => {
          res.upgrade(
            { user: new WSUser(yhub, null, docRef, permissions, authInfo, gc, customAttributions) },
            headerWsKey,
            headerWsProtocol,
            headerWsExtensions,
            context
          )
        })
      } catch (err) {
        if (aborted) return
        if (isApiError(err)) {
          log.info({ url, status: err.status, reason: err.message, ...err.extra }, 'ws upgrade denied')
          res.cork(() => {
            res.writeStatus(statusLine(err.status)).end(err.message)
          })
        } else {
          log.error({ url, err }, 'ws upgrade failed')
          res.cork(() => {
            res.writeStatus('500 Internal Server Error').end('Internal Server Error')
          })
        }
      }
    },
    open: async (ws) => {
      const user = ws.getUserData().user
      user.ws = ws
      user.log.info({ ip: Buffer.from(ws.getRemoteAddressAsText()).toString() }, 'client connected')
      try {
        const doctable = await yhub.getDoc(user.docRef, { gc: user.gc, nongc: !user.gc, awareness: user.permissions.awareness[1] === 'r' }, { gcOnMerge: false })
        // also the upgrade-time check: a reconnecting client is refused here, and so is one whose
        // document was deleted between the upgrade and this initial sync - a window the stream
        // cannot cover, because `lastReceivedClock` is only set below
        if (doctable.tombstone != null) {
          user.log.info('document deleted, refusing to sync')
          user.closeDocDeleted()
          return
        }
        const ydoc = doctable.gcDoc || doctable.nongcDoc || Y.encodeStateAsUpdate(new Y.Doc())
        const sv = await yhub.computePool.computeStateVector(ydoc, { docRef: user.docRef })
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
          if (aw != null && aw.byteLength > 3) {
            user.sendData(aw)
          }
        })
        user.lastReceivedClock = doctable.lastClock
        yhub.stream.subscribe(user.docRef, user)
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
      try {
        // It is important to copy the data here
        const message = Buffer.from(messageBuffer.slice(0, messageBuffer.byteLength))
        const decoder = decoding.createDecoder(message)
        switch (decoding.readVarUint(decoder)) {
          case 0: { // sync message
            // silently dropped without update access on both the data (ydoc `u`) and the route
            // (endpoint `ws` `u`) - same treatment as the old blanket gate
            if (user.permissions.ydoc[2] !== 'u' || endpointPermission(user.permissions, 'ws')[2] !== 'u') return
            const syncMessageType = decoding.readVarUint(decoder)
            if (syncMessageType === protocol.messageSyncUpdate || syncMessageType === protocol.messageSyncStep2) {
              const update = decoding.readVarUint8Array(decoder)
              if (update.byteLength > 3) {
                // an anonymous socket never holds ydoc `u` and ws `u` together (upgrade invariant,
                // kept by recheckAuth: a newly granted mask differs from the stored one and closes
                // the connection)
                const contentmap = createContentMapFromParams(Y.createContentIdsFromUpdate(update), /** @type {string} */ (user.userid), user.customAttributions)
                yhub.stream.addMessage(user.docRef, { type: 'ydoc:update:v1', contentmap, update }).catch(handleErr)
              }
            } else if (syncMessageType === protocol.messageSyncStep1) {
              // can be safely ignored because we send the full initial state at the beginning
            } else {
              user.log.warn({ syncMessageType }, 'unknown sync message type')
            }
            break
          }
          case 1: { // awareness message - read-only connections may broadcast presence when granted
            if (user.permissions.awareness[2] !== 'u') return
            const update = decoding.readVarUint8Array(decoder)
            const awDecoder = decoding.createDecoder(update)
            const alen = decoding.readVarUint(awDecoder) // number of awareness updates
            const awId = decoding.readVarUint(awDecoder)
            if (alen === 1 && (user.awarenessId === null || user.awarenessId === awId)) { // only update awareness if len=1
              user.awarenessId = awId
              user.awarenessLastClock = decoding.readVarUint(awDecoder)
            }
            yhub.stream.addMessage(user.docRef, { type: 'awareness:v1', update }).catch(handleErr)
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
