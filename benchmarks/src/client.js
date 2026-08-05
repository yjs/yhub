import { WebSocket } from 'ws'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as promise from 'lib0/promise'
import * as protocol from '../../src/protocol.js'
import config from './config.js'
import { makeNonceUpdate } from './fixtures.js'

/**
 * A raw-protocol y/hub client.
 *
 * Deliberately not a Yjs client: 1500 clients each holding a 40 MB `Y.Doc` does
 * not fit on one machine, and would measure client memory rather than server
 * memory. This reads the leading varuints of each frame, records the syncStep2
 * byte count and arrival time, and discards the payload without ever copying it.
 *
 * This is protocol-legal rather than a shortcut: the server ignores client
 * syncStep1 (`src/server.js:789`) and reacts only to syncStep2/syncUpdate, so a
 * passive client never owes the server a diff. A few real `@y/websocket` clients
 * are run alongside (see `verify.js`) to confirm edits actually arrive.
 */

const MAX_PAYLOAD = 500 * 1024 * 1024

export class RawClient {
  /**
   * @param {object} opts
   * @param {number} opts.port
   * @param {string} opts.docid
   * @param {string} [opts.org]
   * @param {string} [opts.branch]
   * @param {boolean} [opts.gc]
   */
  constructor ({ port, docid, org = config.hub.org, branch = 'main', gc = true }) {
    this.url = `ws://localhost:${port}/api/ws/v1/${encodeURIComponent(org)}/${encodeURIComponent(docid)}?branch=${branch}&gc=${gc}`
    this.docid = docid
    /** @type {WebSocket|null} */
    this.ws = null
    /** connect -> syncStep2 received, ms */
    this.syncTimeMs = 0
    /** bytes of the syncStep2 payload */
    this.syncBytes = 0
    /** frames received after the initial sync */
    this.updatesReceived = 0
    this.bytesReceived = 0
    this.awarenessReceived = 0
    /** closed by the server for backpressure, or otherwise abnormally */
    this.dropped = false
    /** @type {Array<{ needle: Buffer, resolve: (t: number) => void }>} */
    this._watchers = []
  }

  /**
   * Resolves once syncStep2 has arrived.
   * @return {Promise<RawClient>}
   */
  connect () {
    const started = performance.now()
    return promise.create((resolve, reject) => {
      const ws = new WebSocket(this.url, { maxPayload: MAX_PAYLOAD, perMessageDeflate: false })
      this.ws = ws
      ws.binaryType = 'nodebuffer'
      let synced = false
      ws.on('message', /** @param {Buffer} data */ data => {
        this.bytesReceived += data.length
        const decoder = decoding.createDecoder(data)
        const messageType = decoding.readVarUint(decoder)
        if (messageType === protocol.messageSync) {
          const syncType = decoding.readVarUint(decoder)
          const len = decoding.readVarUint(decoder)
          if (syncType === protocol.messageSyncStep2 && !synced) {
            synced = true
            this.syncBytes = len
            this.syncTimeMs = performance.now() - started
            resolve(this)
          } else if (syncType === protocol.messageSyncUpdate) {
            this.updatesReceived++
            this._matchWatchers(data)
          }
        } else if (messageType === protocol.messageAwareness) {
          this.awarenessReceived++
        }
      })
      ws.on('error', err => { if (!synced) reject(err) })
      ws.on('close', code => {
        // 1000/1005 are ordinary closes; anything else after a successful open
        // is the server dropping us, e.g. the backpressure limit in server.js
        if (synced && code !== 1000 && code !== 1005) this.dropped = true
        if (!synced) reject(new Error(`closed before sync (code ${code})`))
      })
    })
  }

  /**
   * @param {Buffer} data
   */
  _matchWatchers (data) {
    if (this._watchers.length === 0) return
    const now = performance.now()
    for (let i = this._watchers.length - 1; i >= 0; i--) {
      if (data.indexOf(this._watchers[i].needle) !== -1) {
        this._watchers[i].resolve(now)
        this._watchers.splice(i, 1)
      }
    }
  }

  /**
   * Resolve when a frame containing `needle` arrives. The needle is a nonce
   * embedded in the writer's update, which survives the server's per-subscriber
   * re-merge, so this measures true edit-to-observer propagation.
   *
   * @param {Buffer} needle
   * @param {number} timeoutMs
   * @return {Promise<number>} arrival timestamp, or -1 on timeout
   */
  awaitNonce (needle, timeoutMs = 30000) {
    return promise.create(resolve => {
      const watcher = { needle, resolve }
      this._watchers.push(watcher)
      setTimeout(() => {
        const i = this._watchers.indexOf(watcher)
        if (i !== -1) { this._watchers.splice(i, 1); resolve(-1) }
      }, timeoutMs).unref()
    })
  }

  /**
   * @param {Uint8Array} frame a pre-encoded protocol frame
   */
  send (frame) {
    this.ws?.send(frame)
  }

  close () {
    this.ws?.close()
  }
}

/**
 * @param {Uint8Array<ArrayBuffer>} update
 */
export const updateFrame = update => protocol.encodeSyncUpdate(update)

/**
 * Encode one presence update by hand. Building an `Awareness` instance per
 * synthetic client would cost a throwaway `Y.Doc` each; the wire format is just
 * `(changeCount, clientId, clock, JSON)` — see `encodeAwarenessUserDisconnected`
 * in `src/protocol.js`.
 *
 * @param {number} clientId
 * @param {number} clock
 * @param {any} state
 */
export const awarenessUpdate = (clientId, clock, state) => encoding.encode(enc => {
  encoding.writeVarUint(enc, 1)
  encoding.writeVarUint(enc, clientId)
  encoding.writeVarUint(enc, clock)
  encoding.writeVarString(enc, JSON.stringify(state))
})

/**
 * @param {number} clientId
 * @param {number} clock
 * @param {any} state
 */
export const awarenessFrame = (clientId, clock, state) =>
  encoding.encode(enc => protocol.writeAwarenessUpdate(enc, awarenessUpdate(clientId, clock, state)))

/** A bare cursor, and a realistic presence payload with name, colour, selection. */
export const awarenessStates = {
  small: { cursor: { row: 12, col: 4 } },
  large: {
    user: { name: 'Benchmark User', color: '#ffb61e', colorLight: '#ffb61e33', id: 'user-000000' },
    cursor: { anchor: { row: 12, col: 4 }, head: { row: 18, col: 9 } },
    selection: { ranges: [{ startRow: 12, startCol: 4, endRow: 18, endCol: 9 }], activeSheet: 'Sheet1' },
    lastActive: 1750000000000
  }
}

/**
 * Connect `count` clients, optionally ramped.
 *
 * @param {object} opts
 * @param {number} opts.count
 * @param {(i: number) => { port: number, docid: string }} opts.target
 * @param {number} [opts.ratePerSecond] `0`/undefined connects all at once
 * @return {Promise<Array<RawClient>>}
 */
export const connectClients = async ({ count, target, ratePerSecond = 0 }) => {
  /** @type {Array<RawClient>} */
  const clients = []
  /** @type {Array<Promise<any>>} */
  const pending = []
  for (let i = 0; i < count; i++) {
    const client = new RawClient(target(i))
    clients.push(client)
    pending.push(client.connect().catch(err => { client.dropped = true; return err }))
    if (ratePerSecond > 0) await promise.wait(1000 / ratePerSecond)
  }
  await promise.all(pending)
  return clients
}

/**
 * @param {Array<RawClient>} clients
 */
export const closeClients = clients => clients.forEach(c => c.close())

/**
 * Edit sent by one client -> observed by another.
 *
 * Each edit carries a distinct nonce as its cell value; every observer waits for
 * that nonce to appear in an inbound frame. Only one edit is in flight at a
 * time, so the percentiles describe the delivery path rather than queueing
 * behind the previous edit.
 *
 * @param {object} opts
 * @param {RawClient} opts.writer
 * @param {Array<RawClient>} opts.observers
 * @param {number} opts.count
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.timeoutMs]
 */
export const measurePropagation = async ({ writer, observers, count, intervalMs = 50, timeoutMs = 15000 }) => {
  /** @type {Array<number>} */
  const samples = []
  let lost = 0
  for (let i = 0; i < count; i++) {
    const nonce = `<<prop-${process.pid}-${i}>>`
    const waits = observers.map(o => o.awaitNonce(Buffer.from(nonce), timeoutMs))
    const sentAt = performance.now()
    writer.send(updateFrame(makeNonceUpdate(nonce)))
    const arrivals = await promise.all(waits)
    arrivals.forEach(t => t > 0 ? samples.push(t - sentAt) : lost++)
    await promise.wait(intervalMs)
  }
  return { samples, lost }
}
