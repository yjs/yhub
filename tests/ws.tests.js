import * as Y from '@y/y'
import * as t from 'lib0/testing'
import * as promise from 'lib0/promise'
import * as encoding from 'lib0/encoding'
import WebSocket from 'ws'
import * as utils from './utils.js'
import * as protocol from '../src/protocol.js'
import { WSUser } from '../src/server.js'
import { mergeUpdates } from '../src/y-utils.js'
import { normalizeDocumentPermissions } from '../src/permissions.js'

/**
 * @param {t.TestCase} tc
 */
export const testSyncAndCleanup = async tc => {
  const removedAfterXTimeouts = 6 // always needs min 2x of minMessageLifetime
  const { createWsClient, yhub, defaultStream, defaultDocRef } = await utils.createTestCase(tc)
  const redisClient = yhub.stream.redis
  const { ydoc: doc1 } = createWsClient({ syncAwareness: false })
  // doc2: can retrieve changes propagated on stream
  const { ydoc: doc2 } = createWsClient({ syncAwareness: false })
  await promise.wait(1000)
  doc1.get().setAttr('a', 1)
  t.info('docs syncing (0)')
  await utils.waitDocsSynced(doc1, doc2)
  await promise.wait(1000)
  t.info('docs synced (1)')
  const docStreamExistsBefore = await redisClient.exists(defaultStream)
  console.log('a:', doc2.get().getAttr('a'))
  console.log(doc2.store.clients.size, doc2.store.clients, doc2.store.pendingStructs)
  t.assert(doc2.get().getAttr('a') === 1)
  // doc3 can retrieve older changes from stream
  const { ydoc: doc3 } = createWsClient({ syncAwareness: false })
  await utils.waitDocsSynced(doc1, doc3)
  t.info('docs synced (2)')
  t.assert(doc3.get().getAttr('a') === 1)
  await promise.wait(yhub.stream.minMessageLifetime * removedAfterXTimeouts + 3000)
  const docStreamExists = await redisClient.exists(defaultStream)
  const workerLen = await redisClient.xLen(yhub.stream.workerStreamName)
  console.log({ docStreamExists, docStreamExistsBefore, workerLen })
  t.assert(!docStreamExists && docStreamExistsBefore)
  if (workerLen !== 0) {
    console.warn('worker len should be zero - but there could be leaks from other streams')
  }
  t.info('stream cleanup after initial changes')
  // doc4 can retrieve the document again from MemoryStore
  const { ydoc: doc4 } = createWsClient({ syncAwareness: false })
  await utils.waitDocsSynced(doc3, doc4)
  t.info('docs synced (3)')
  t.assert(doc3.get().getAttr('a') === 1)
  const { references } = await yhub.getDoc(defaultDocRef, { references: true, gc: true })
  t.assert(references.length === 1 * 2)
  t.info('doc retrieved')
  // now write another updates that the worker will collect
  doc1.get().setAttr('a', 2)
  await promise.wait(yhub.stream.minMessageLifetime * removedAfterXTimeouts)
  t.assert(doc2.get().getAttr('a') === 2)
  const { references: references2 } = await yhub.getDoc(defaultDocRef, { references: true, gc: true })
  t.info('map retrieved')
  // should delete old references
  t.assert(references2.length === 1 * 2)
}

/**
 * A disconnect awareness update (state=null) seeded in the Redis stream must be
 * delivered to a freshly connecting client. Previously `mergeAwarenessUpdates`
 * encoded from `aw.states.keys()`, which dropped removed clients on the floor and
 * left ghost cursors on receiving pods.
 *
 * @param {t.TestCase} tc
 */
export const testAwarenessDisconnectDeliveredOnConnect = async tc => {
  const { createWsClient, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const fakeClientid = 0xfeed
  /**
   * @param {number} clientid
   * @param {number} clock
   * @param {any} state
   */
  const encodeOneEntry = (clientid, clock, state) => encoding.encode(encoder => {
    encoding.writeVarUint(encoder, 1)
    encoding.writeVarUint(encoder, clientid)
    encoding.writeVarUint(encoder, clock)
    encoding.writeVarString(encoder, JSON.stringify(state))
  })
  // fake client appears with a state, then disconnects
  await yhub.stream.addMessage(defaultDocRef, { type: 'awareness:v1', update: encodeOneEntry(fakeClientid, 1, { user: 'alice' }) })
  await yhub.stream.addMessage(defaultDocRef, { type: 'awareness:v1', update: encodeOneEntry(fakeClientid, 2, null) })

  const { provider } = await createWsClient({ waitForSync: true })
  await promise.wait(200) // give the awareness snapshot a moment to be applied

  t.assert(!provider.awareness.states.has(fakeClientid), 'disconnected client absent from awareness.states')
  const meta = provider.awareness.meta.get(fakeClientid)
  t.assert(meta?.clock === 2, 'disconnect recorded in awareness.meta with preserved clock')
}

/**
 * A document that only ever receives awareness messages must NOT be persisted. Awareness carries
 * no document content, so it must not advance the compaction guard (which now compares against
 * `lastUpdateClock`, not the awareness-inclusive `lastClock`). The stream is still trimmed and
 * cleaned up once the awareness entries age past `minMessageLifetime`.
 *
 * @param {t.TestCase} tc
 */
export const testAwarenessOnlyDoesNotPersist = async tc => {
  const { yhub, defaultDocRef, defaultStream } = await utils.createTestCase(tc)
  /**
   * @param {number} clientid
   * @param {number} clock
   * @param {any} state
   */
  const encodeOneEntry = (clientid, clock, state) => encoding.encode(encoder => {
    encoding.writeVarUint(encoder, 1)
    encoding.writeVarUint(encoder, clientid)
    encoding.writeVarUint(encoder, clock)
    encoding.writeVarString(encoder, JSON.stringify(state))
  })
  t.info('seeding the stream with awareness-only messages (schedules a compact task)')
  await yhub.stream.addMessage(defaultDocRef, { type: 'awareness:v1', update: encodeOneEntry(0xc0ffee, 1, { user: 'alice' }) })
  await yhub.stream.addMessage(defaultDocRef, { type: 'awareness:v1', update: encodeOneEntry(0xc0ffee, 2, { user: 'alice', typing: true }) })

  t.info('waiting for compaction to run and the stream to be cleaned up')
  await utils.waitTasksProcessed(yhub)

  t.info('asserting nothing was persisted and the stream was trimmed away')
  const persisted = await yhub.persistence.retrieveDoc(defaultDocRef, { gc: true })
  t.assert(persisted.lastClock === '0', 'awareness-only document must not be persisted')
  t.assert(persisted.gcDoc.length === 0, 'no gc doc assets should exist for an awareness-only document')
  const streamExists = await yhub.stream.redis.exists(defaultStream)
  t.assert(!streamExists, 'awareness-only stream should be trimmed and deleted (no persist, no infinite re-enqueue)')
}

/**
 * A document that only ever receives auth:check directives must NOT be persisted (the compaction
 * guard only advances on update/prune messages). The stream is still trimmed and cleaned up
 * once the entries age past `minMessageLifetime`.
 *
 * @param {t.TestCase} tc
 */
export const testAuthCheckOnlyDoesNotPersist = async tc => {
  const { yhub, defaultDocRef, defaultStream } = await utils.createTestCase(tc)
  t.info('seeding the stream with an auth:check message (schedules a compact task)')
  await yhub.recheckAuth(defaultDocRef, { forceDisconnect: true })
  t.info('waiting for compaction to run and the stream to be cleaned up')
  await utils.waitTasksProcessed(yhub)
  t.info('asserting nothing was persisted and the stream was trimmed away')
  const persisted = await yhub.persistence.retrieveDoc(defaultDocRef, { gc: true })
  t.assert(persisted.lastClock === '0', 'auth-check-only document must not be persisted')
  t.assert(persisted.gcDoc.length === 0, 'no gc doc assets should exist for an auth-check-only document')
  const streamExists = await yhub.stream.redis.exists(defaultStream)
  t.assert(!streamExists, 'auth-check-only stream should be trimmed and deleted (no persist, no infinite re-enqueue)')
}

/**
 * `unsafePersistDoc` used to stamp its row `${ms}-I`. The first client to open such a document
 * handed that clock to the shared `XREAD`, which redis rejected as a whole - no document on the
 * server received stream updates anymore until the client disconnected.
 *
 * @param {t.TestCase} tc
 */
export const testUnsafePersistDocKeepsFanOut = async tc => {
  const { createWsClient, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const imported = new Y.Doc()
  imported.get().setAttr('imported', 1)
  await yhub.unsafePersistDoc(defaultDocRef, Y.encodeStateAsUpdate(imported), { by: 'importer' })
  t.assert((await yhub.persistence.retrieveDoc(defaultDocRef, {})).lastClock.endsWith('-0'), 'persisted clock is a valid stream id')
  t.info('a client pair in another room exchanges updates')
  const { ydoc: other1 } = await createWsClient({ docid: 'other', waitForSync: true })
  const { ydoc: other2 } = await createWsClient({ docid: 'other', waitForSync: true })
  other2.get().setAttr('x', 1)
  await promise.until(10000, () => other1.get().getAttr('x') === 1)
  t.info('client A opens the imported document')
  const { ydoc: docA } = await createWsClient({ waitForSync: true })
  t.assert(docA.get().getAttr('imported') === 1)
  t.info('client B sends an update, A receives it')
  const { ydoc: docB } = await createWsClient({ waitForSync: true })
  docB.get().setAttr('b', 1)
  await promise.until(10000, () => docA.get().getAttr('b') === 1)
  t.info('the other room keeps receiving updates')
  other2.get().setAttr('x', 2)
  await promise.until(10000, () => other1.get().getAttr('x') === 2)
}

/**
 * @param {t.TestCase} tc
 */
export const testGcNonGcDocs = async tc => {
  const { createWsClient } = await utils.createTestCase(tc)
  const { ydoc: ydocGc } = createWsClient()
  ydocGc.get().setAttr('a', 1)
  await promise.wait(500)
  ydocGc.get().setAttr('a', 2)
  await promise.wait(100)
  const { ydoc: ydocNoGc } = createWsClient({ gc: false })
  await utils.waitDocsSynced(ydocGc, ydocNoGc)
  t.assert(ydocNoGc.get().getAttr('a') === 2)
  // check that content was not gc'd
  t.assert(ydocNoGc.get()._map.get('a')?.left?.content.getContent()[0] === 1)
}

/**
 * A present-but-empty `?branch=` must be refused. uws yields `''` for it (an absent key yields
 * `undefined`), which would address a branch that is not `main` and silently split the document
 * away from it - its own stream, its own snapshots. See yjs/yhub#68.
 *
 * @param {t.TestCase} tc
 */
export const testEmptyBranchIsRejected = async tc => {
  const { org, defaultDocRef, createWsClient } = await utils.createTestCase(tc)
  // the provider reconnect-loops on a refused upgrade, so the status is read off a raw socket
  /**
   * @param {string} query
   */
  const wsStatus = query => promise.create(resolve => {
    const ws = new WebSocket(`ws://${utils.yhubHost}/api/ws/v1/${org}/${defaultDocRef.docid}${query}`)
    ws.on('open', () => { ws.close(); resolve('open') })
    ws.on('unexpected-response', (_req, res) => { ws.terminate(); resolve(`${res.statusCode}`) })
    ws.on('error', () => resolve('error'))
  })
  t.assert(await wsStatus('?branch=') === '400', 'an empty ?branch= must be refused with 400')
  t.assert(await wsStatus('?branch=main') === 'open', '?branch=main must connect')
  t.assert(await wsStatus('') === 'open', 'an absent ?branch must connect')

  t.info('an absent ?branch addresses the same document as ?branch=main')
  const { ydoc: explicit } = await createWsClient({ branch: 'main', waitForSync: true })
  explicit.get().setAttr('a', 1)
  const { ydoc: implicit } = await createWsClient({ branch: null, waitForSync: true })
  await promise.until(10000, () => implicit.get().getAttr('a') === 1)
}

/**
 * A stream batch is encoded once: every connection it is fanned out to is sent the identical frame
 * object, so the ydoc and awareness merges don't run per connection. The awareness read gate stays
 * per connection.
 *
 * @param {t.TestCase} tc
 */
export const testStreamBatchEncodedOnce = async tc => {
  const { yhub, defaultDocRef } = await utils.createTestCase(tc)
  /**
   * @param {import('../src/permissions.js').CRUD} awareness
   */
  const createUser = awareness => {
    /**
     * @type {Array<Uint8Array>}
     */
    const sent = []
    const ws = /** @type {any} */ ({ send: (/** @type {Uint8Array} */ m) => { sent.push(m); return 1 }, getBufferedAmount: () => 0 })
    const user = new WSUser(yhub, ws, defaultDocRef, normalizeDocumentPermissions({ type: 'permissions:document:v1', ydoc: '-r--', awareness }), null, true, [])
    return { user, sent }
  }
  const a = createUser('-r--')
  const b = createUser('-r--')
  const c = createUser('----')
  const ydoc = new Y.Doc()
  ydoc.get().setAttr('a', 1)
  const u1 = Y.encodeStateAsUpdate(ydoc)
  const sv = Y.encodeStateVector(ydoc)
  ydoc.get().setAttr('b', 2)
  const u2 = Y.encodeStateAsUpdate(ydoc, sv)
  const aw = encoding.encode(encoder => {
    encoding.writeVarUint(encoder, 1)
    encoding.writeVarUint(encoder, 0xfeed)
    encoding.writeVarUint(encoder, 1)
    encoding.writeVarString(encoder, JSON.stringify({ user: 'alice' }))
  })
  const ms = /** @type {Array<any>} */ ([
    { type: 'ydoc:update:v1', update: u1, contentmap: new Uint8Array(), redisClock: '1-0' },
    { type: 'ydoc:update:v1', update: u2, contentmap: new Uint8Array(), redisClock: '2-0' },
    { type: 'awareness:v1', update: aw, redisClock: '3-0' }
  ])
  ;[a, b, c].forEach(({ user }) => user.onStreamMessage(defaultDocRef, ms))
  t.assert(a.sent.length === 2 && b.sent.length === 2, 'awareness readers get the sync and the awareness frame')
  t.assert(c.sent.length === 1, 'presence is gated per connection')
  t.assert(a.sent[0] === b.sent[0] && a.sent[0] === c.sent[0], 'one sync frame per batch')
  t.assert(a.sent[1] === b.sent[1], 'one awareness frame per batch')
  t.compare(a.sent[0], protocol.encodeSyncUpdate(mergeUpdates(false, [u1, u2])))
  t.compare(a.sent[1], protocol.mergeAwarenessUpdates([aw]))
  t.info('a single ydoc update is relayed unmerged')
  a.user.onStreamMessage(defaultDocRef, [ms[0]])
  t.compare(a.sent[2], protocol.encodeSyncUpdate(u1))
}
