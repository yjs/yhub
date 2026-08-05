import * as Y from '@y/y'
import * as promise from 'lib0/promise'
import { WebSocket } from 'ws'
import { WebsocketProvider } from '@y/websocket'
import config from './config.js'
import { RawClient, updateFrame } from './client.js'
import { makeBatchUpdate } from './fixtures.js'

/**
 * Harness self-check.
 *
 * The load generator is a raw-protocol client that discards payloads, which is
 * what makes 1500 connections affordable — but it also means it cannot notice if
 * the bytes it counted were wrong. So a couple of real `@y/websocket` clients
 * run alongside and are asked whether the edits actually arrived and converged.
 *
 * If this fails, every number in RESULTS.md is suspect.
 */

const WsPolyfill = /** @type {any} */ (class extends WebSocket {
  /**
   * @param {string} url
   * @param {string|string[]} [protocols]
   */
  constructor (url, protocols) {
    super(url, protocols, { maxPayload: 500 * 1024 * 1024 })
  }
})

/**
 * @param {string} docid
 */
const realClient = docid => {
  const ydoc = new Y.Doc({ guid: docid })
  const provider = new WebsocketProvider(`ws://localhost:${config.hub.basePort}/api/ws/v1/${config.hub.org}`, docid, ydoc, {
    WebSocketPolyfill: WsPolyfill,
    socketTimeout: 1000_000,
    disableBc: true,
    params: { branch: 'main', gc: 'true' }
  })
  // `ydoc.whenSynced` is never settled by the provider itself — the same bridge
  // `tests/utils.js` installs. Without it this waits forever.
  const synced = promise.create(resolve => provider.once('sync', () => resolve(null)))
  return { ydoc, provider, synced }
}

/**
 * @param {import('./cluster.js').Cluster} cluster
 * @param {(row: {[k: string]: string|number}) => void} row
 */
export const verifyHarness = async (cluster, row) => {
  const docid = 'verify'
  const cells = 500

  // 1. a real client writes, a raw client observes the relay
  const a = realClient(docid)
  await a.synced
  const rawObserver = await new RawClient({ port: cluster.ports[0], docid }).connect()
  a.ydoc.transact(() => {
    for (let i = 0; i < cells; i++) a.ydoc.get('cells').setAttr(`v:${i}`, `value-${i}`)
  })
  await promise.untilAsync(async () => rawObserver.updatesReceived > 0, 15000)

  // 2. a raw client writes, a real client reads it back and must agree
  const rawWriter = await new RawClient({ port: cluster.ports[0], docid }).connect()
  rawWriter.send(updateFrame(makeBatchUpdate(cells, 424242)))
  await cluster.awaitWrite({ docid })
  await promise.wait(500)

  // 3. a second real client joins cold and must converge with the first
  const b = realClient(docid)
  await b.synced
  await promise.untilAsync(async () => {
    const diff = Y.excludeContentIds(Y.createContentIdsFromDoc(a.ydoc, true), Y.createContentIdsFromDoc(b.ydoc, true))
    return diff.deletes.isEmpty() && diff.inserts.isEmpty()
  }, 30000)

  const attrsA = a.ydoc.get('cells').attrSize
  const attrsB = b.ydoc.get('cells').attrSize
  const converged = attrsA === attrsB && attrsA >= cells * 2

  row({
    check: 'real client writes -> raw client observes',
    result: rawObserver.updatesReceived > 0 ? 'pass' : 'FAIL',
    detail: `${rawObserver.updatesReceived} frames relayed`
  })
  row({
    check: 'raw client writes -> real client reads',
    result: attrsA >= cells * 2 ? 'pass' : 'FAIL',
    detail: `${attrsA} cells in the writer's document`
  })
  row({
    check: 'cold join converges with live client',
    result: converged ? 'pass' : 'FAIL',
    detail: `${attrsB} cells after sync, syncStep2 was ${(rawObserver.syncBytes / 1024).toFixed(1)} KB`
  })

  ;[a, b].forEach(c => { c.provider.destroy(); c.ydoc.destroy() })
  rawObserver.close()
  rawWriter.close()
  await cluster.drain(60000)
  return converged
}
