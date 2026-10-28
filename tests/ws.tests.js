import * as Y from '@y/y'
import * as t from 'lib0/testing'
import * as promise from 'lib0/promise'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import WebSocket from 'ws'
import * as utils from './utils.js'
import * as types from '../src/types.js'
import * as protocol from '../src/protocol.js'
import { WSUser, wsCloseDocDeleted } from '../src/server.js'
import { mergeUpdates, createContentMap } from '../src/y-utils.js'
import { normalizeDocumentPermissions } from '../src/permissions.js'

const keepAlivePort = utils.testHubPort(10)

// grants awareness `u` alone: the socket is never relayed presence, so every awareness message it
// receives is a keep-alive
await utils.createTestHub({
  worker: null,
  server: {
    port: keepAlivePort,
    wsKeepAliveInterval: 200,
    auth: types.createAuthPlugin({
      async authenticate () {
        return { userid: 'user1' }
      },
      authorize: types.createAuthorize({
        document: async () => ({ type: 'permissions:document:v1', ydoc: '-r--', awareness: '--u-', endpoint: { ws: '-r--' } })
      })
    })
  }
})

const smallDocPort = utils.testHubPort(13)

// backpressure limit at 1.2 MB: a larger document trips it during the initial sync
const smallDocHub = await utils.createTestHub({
  worker: null,
  server: { ...utils.yhub.conf.server, port: smallDocPort, maxDocSize: 1_000_000 }
})

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
 * no document content, so it must not advance the compaction guard (which compares the clock of
 * the last content message, not the awareness-inclusive `streamClock`). The stream is still trimmed and
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

/**
 * An idle connection is sent an empty awareness message every `wsKeepAliveInterval` ms - clients
 * reconnect when they receive nothing for a while (y-websocket: `socketTimeout`).
 *
 * @param {t.TestCase} tc
 */
export const testKeepAlive = async tc => {
  const { defaultDocRef } = await utils.createTestCase(tc)
  const ws = new WebSocket(`${utils.wsUrlFromPort(keepAlivePort)}/${defaultDocRef.docid}`)
  ws.on('open', () => ws.send(utils.syncStep1))
  /**
   * @type {Array<Uint8Array>}
   */
  const awarenessUpdates = []
  ws.on('message', data => {
    const decoder = decoding.createDecoder(/** @type {Buffer} */ (data))
    decoding.readVarUint(decoder) === protocol.messageAwareness && awarenessUpdates.push(decoding.readVarUint8Array(decoder))
  })
  await promise.until(1000, () => awarenessUpdates.length > 0)
  t.assert(decoding.readVarUint(decoding.createDecoder(awarenessUpdates[0])) === 0, 'an awareness update with zero entries')
  ws.close()
}

/**
 * The updates `ydoc` sends - its own changes, not the ones the provider applied.
 *
 * @param {Y.Doc} ydoc
 * @param {any} provider
 */
const recordEdits = (ydoc, provider) => {
  /**
   * @type {Array<Uint8Array<ArrayBuffer>>}
   */
  const edits = []
  ydoc.on('update', (update, origin) => { origin !== provider && edits.push(update) })
  return edits
}

/**
 * @param {Y.ContentIds} a
 * @param {Y.ContentIds} b
 */
const equalContentIds = (a, b) => [Y.excludeContentIds(a, b), Y.excludeContentIds(b, a)].every(d => d.inserts.isEmpty() && d.deletes.isEmpty())

/**
 * Waits until each of `edits` is on the stream of `docRef`, attributed with exactly its own ids,
 * then checks that no other update is. Compaction must be disabled for the document, so that
 * nothing is trimmed meanwhile.
 *
 * @param {import('../src/index.js').YHub} yhub
 * @param {types.DocRef} docRef
 * @param {Array<Uint8Array<ArrayBuffer>>} edits
 */
const expectStreamedEdits = async (yhub, docRef, edits) => {
  const expected = edits.map(edit => Y.createContentIdsFromUpdate(edit))
  /**
   * @type {Array<Y.ContentIds>}
   */
  let streamed = []
  await promise.untilAsync(async () => {
    const messages = (await yhub.stream.getMessages([{ docRef, clock: '0' }]))[0]?.messages ?? []
    streamed = messages.flatMap(m => m.type === 'ydoc:update:v1' ? [Y.createContentIdsFromContentMap(Y.decodeContentMap(m.contentmap))] : [])
    return expected.every(e => streamed.some(s => equalContentIds(s, e)))
  }, 10000)
  t.assert(streamed.length === expected.length, `only the edits are on the stream (${streamed.length} updates for ${expected.length} edits)`)
}

/**
 * A resync appends nothing to the stream. The server sends its sync step 1 before its step 2, so
 * a client without state answers it with an empty update. A client that already holds the
 * document re-sends every delete it knows (a state vector can't describe deletes) - deletes the
 * server had accepted already. Before, every reconnect of a writer appended its whole delete set,
 * attributed to the reconnecting user.
 *
 * Each socket delivers in order, so once an edit made after a handshake is on the stream, the
 * answer to that handshake was processed before it.
 *
 * @param {t.TestCase} tc
 */
export const testResyncAppendsNothing = async tc => {
  const { createWsClient, yhub, defaultDocRef } = await utils.createTestCase(tc)
  await yhub.stream.disableCompaction(defaultDocRef)
  try {
    const { ydoc: doc1, provider: provider1 } = await createWsClient({ waitForSync: true })
    const edits = recordEdits(doc1, provider1)
    doc1.get().insert(0, 'hello world')
    doc1.get().delete(0, 6)
    await expectStreamedEdits(yhub, defaultDocRef, edits)
    t.info('a writer that holds the document reconnects')
    provider1.disconnect()
    provider1.connect()
    await promise.until(10000, () => provider1.synced)
    t.info('a writer without state connects')
    const { ydoc: doc2, provider: provider2 } = await createWsClient({ waitForSync: true })
    const edits2 = recordEdits(doc2, provider2)
    doc1.get().insert(0, 'a')
    doc2.get().insert(0, 'b')
    await expectStreamedEdits(yhub, defaultDocRef, [...edits, ...edits2])
  } finally {
    await yhub.stream.enableCompaction(defaultDocRef)
  }
}

/**
 * Edits made offline reach the server with the answer to its sync step 1, together with every
 * delete the client knows. Only the offline edits are attributed to the client.
 *
 * @param {t.TestCase} tc
 */
export const testOfflineEditsAttributedOnce = async tc => {
  const { createWsClient, yhub, defaultDocRef } = await utils.createTestCase(tc)
  await yhub.stream.disableCompaction(defaultDocRef)
  try {
    const { ydoc: doc1, provider: provider1 } = await createWsClient({ waitForSync: true })
    const { ydoc: doc2 } = await createWsClient({ waitForSync: true })
    const edits = recordEdits(doc1, provider1)
    doc1.get().insert(0, 'hello world')
    doc1.get().delete(0, 6)
    await expectStreamedEdits(yhub, defaultDocRef, edits)
    provider1.disconnect()
    doc1.get().insert(5, '!!')
    doc1.get().delete(0, 2)
    provider1.connect()
    await utils.waitDocsSynced(doc1, doc2)
    t.compare(doc2.get().toString(), 'rld!!')
    // both offline edits arrive in the one answer
    await expectStreamedEdits(yhub, defaultDocRef, [...edits.slice(0, 2), Y.mergeUpdates(edits.slice(2))])
  } finally {
    await yhub.stream.enableCompaction(defaultDocRef)
  }
}

/**
 * Every message before the client's sync step 1 is ignored: the connection is subscribed to the
 * stream (auth checks, the document's deletion) only by the initial sync that step starts.
 *
 * @param {t.TestCase} tc
 */
export const testMessagesBeforeSyncStep1Ignored = async tc => {
  const { yhub, defaultDocRef } = await utils.createTestCase(tc)
  const doc = new Y.Doc()
  doc.get().insert(0, 'ignored')
  const ws = new WebSocket(`${utils.wsUrl}/${defaultDocRef.docid}`)
  let received = 0
  ws.on('message', () => { received++ })
  ws.on('open', () => {
    ws.send(protocol.encodeSyncUpdate(Y.encodeStateAsUpdate(doc)))
    ws.send(encoding.encode(encoder => protocol.writeAwarenessUpdate(encoder, protocol.encodeAwarenessUserDisconnected(doc.clientID, 0))))
    ws.send(utils.syncStep1)
  })
  // the socket delivers in order: once the sync step 1 is answered, the messages before it were read
  await promise.until(5000, () => received > 0)
  const messages = (await yhub.stream.getMessages([{ docRef: defaultDocRef, clock: '0' }]))[0]?.messages ?? []
  t.assert(messages.length === 0, 'nothing reached the stream')
  ws.close()
  doc.destroy()
}

/**
 * The server answers a client's sync step 1 with its own step 1, then with the part of the
 * document the client lacks - a reconnecting client is not sent the whole document again.
 *
 * @param {t.TestCase} tc
 */
export const testResyncSendsDiff = async tc => {
  const { createWsClient, defaultDocRef } = await utils.createTestCase(tc)
  const { ydoc: doc1 } = await createWsClient({ waitForSync: true })
  doc1.get().insert(0, 'hello world')
  const { ydoc: doc2 } = await createWsClient({ waitForSync: true })
  await utils.waitDocsSynced(doc1, doc2)
  const ws = new WebSocket(`${utils.wsUrl}/${defaultDocRef.docid}`)
  /**
   * @type {Array<{ type: number, payload: Uint8Array }>}
   */
  const received = []
  ws.on('message', data => {
    const decoder = decoding.createDecoder(/** @type {Buffer} */ (data))
    decoding.readVarUint(decoder) === protocol.messageSync && received.push({ type: decoding.readVarUint(decoder), payload: decoding.readVarUint8Array(decoder) })
  })
  ws.on('open', () => ws.send(protocol.encodeSyncStep1(Y.encodeStateVector(doc1))))
  await promise.until(5000, () => received.length >= 2)
  t.assert(received[0].type === protocol.messageSyncStep1 && received[1].type === protocol.messageSyncStep2, 'step 1, then step 2')
  t.assert(Y.createContentIdsFromUpdate(received[1].payload).inserts.isEmpty(), 'nothing the client already holds')
  ws.close()
}

/**
 * Updates are accepted only from the client's answer to the server's sync step 1 on. An update
 * sent before it is dropped and isn't lost: the server's sync step 1 predates it, so the answer
 * carries it. Before, it was appended twice - on its own and with the answer.
 *
 * The edit made after the answer is on the stream only once the answer was processed - the socket
 * delivers in order.
 *
 * @param {t.TestCase} tc
 */
export const testUpdateBeforeAnswerArrivesWithAnswer = async tc => {
  const { yhub, defaultDocRef } = await utils.createTestCase(tc)
  await yhub.stream.disableCompaction(defaultDocRef)
  try {
    const doc = new Y.Doc()
    /**
     * @type {Array<Uint8Array<ArrayBuffer>>}
     */
    const edits = []
    doc.on('update', update => { edits.push(update) })
    doc.get().insert(0, 'hello')
    const ws = new WebSocket(`${utils.wsUrl}/${defaultDocRef.docid}`)
    ws.on('message', data => {
      const decoder = decoding.createDecoder(/** @type {Buffer} */ (data))
      if (decoding.readVarUint(decoder) === protocol.messageSync && decoding.readVarUint(decoder) === protocol.messageSyncStep1) {
        ws.send(protocol.encodeSyncStep2(Y.encodeStateAsUpdate(doc, decoding.readVarUint8Array(decoder))))
        doc.get().insert(0, '!')
        ws.send(protocol.encodeSyncUpdate(edits[1]))
      }
    })
    ws.on('open', () => {
      ws.send(utils.syncStep1)
      ws.send(protocol.encodeSyncUpdate(edits[0]))
    })
    await promise.until(5000, () => edits.length === 2)
    await expectStreamedEdits(yhub, defaultDocRef, edits)
    ws.close()
    doc.destroy()
  } finally {
    await yhub.stream.enableCompaction(defaultDocRef)
  }
}

/**
 * A client that keeps its socket open without syncing until the document is deleted, then sends
 * its sync step 1 followed right away by updates, gets nothing onto the stream: the initial sync
 * refuses the deleted document before it sends the sync step 1 that updates have to answer. A
 * revocation is refused the same way, by the initial sync's permission re-check.
 *
 * @param {t.TestCase} tc
 */
export const testUpdatesBeforeInitialSyncChecksIgnored = async tc => {
  const { yhub, defaultDocRef } = await utils.createTestCase(tc)
  const ws = new WebSocket(`${utils.wsUrl}/${defaultDocRef.docid}`)
  await promise.create(resolve => ws.once('open', resolve))
  const closed = promise.create(resolve => ws.once('close', resolve))
  await yhub.deleteDoc(defaultDocRef)
  const doc = new Y.Doc()
  doc.get().insert(0, 'ignored')
  ws.send(utils.syncStep1)
  ws.send(protocol.encodeSyncUpdate(Y.encodeStateAsUpdate(doc)))
  ws.send(protocol.encodeSyncStep2(Y.encodeStateAsUpdate(doc)))
  t.assert(await closed === wsCloseDocDeleted, 'refused by the initial sync')
  const messages = (await yhub.stream.getMessages([{ docRef: defaultDocRef, clock: '0' }]))[0]?.messages ?? []
  t.assert(messages.every(m => m.type !== 'ydoc:update:v1'), 'no update reached the stream')
  doc.destroy()
}

/**
 * A sync step 1 whose state vector takes 10% of `server.maxDocSize` or more closes the connection
 * before the state vector is decoded.
 *
 * @param {t.TestCase} tc
 */
export const testHugeStateVectorRefused = async tc => {
  const { yhub, defaultDocRef } = await utils.createTestCase(tc)
  const ws = new WebSocket(`${utils.wsUrl}/${defaultDocRef.docid}`)
  const closed = promise.create(resolve => ws.once('close', resolve))
  ws.on('open', () => ws.send(protocol.encodeSyncStep1(new Uint8Array(/** @type {number} */ (/** @type {types.YHubConfig} */ (yhub.conf).server?.maxDocSize) / 10))))
  t.assert(await closed === 1009, 'closed with 1009')
}

/**
 * An initial sync that trips the backpressure limit closes the connection from within its own
 * sends - the destroyed user must not be subscribed to the stream afterwards, nothing would ever
 * unsubscribe it.
 *
 * @param {t.TestCase} tc
 */
export const testBackpressureCloseDoesNotLeakSubscription = async tc => {
  const { yhub, defaultDocRef } = await utils.createTestCase(tc)
  const doc = new Y.Doc()
  doc.get().insert(0, 'x'.repeat(20_000_000))
  const update = Y.encodeStateAsUpdate(doc)
  await yhub.stream.addMessage(defaultDocRef, { type: 'ydoc:update:v1', update, contentmap: createContentMap(Y.createContentIdsFromUpdate(update), 'user1', []) })
  // sent after the document's sync step 2, which fills the buffer - this send is dropped
  const awareness = encoding.encode(encoder => {
    encoding.writeVarUint(encoder, 1)
    encoding.writeVarUint(encoder, 0xfeed)
    encoding.writeVarUint(encoder, 1)
    encoding.writeVarString(encoder, JSON.stringify({ user: 'alice' }))
  })
  await yhub.stream.addMessage(defaultDocRef, { type: 'awareness:v1', update: awareness })
  const ws = new WebSocket(`${utils.wsUrlFromPort(smallDocPort)}/${defaultDocRef.docid}`)
  const closed = promise.create(resolve => ws.once('close', resolve))
  ws.on('open', () => ws.send(utils.syncStep1))
  // the close frame queues behind the full buffer - the client doesn't reliably see 1013
  await closed
  t.assert(smallDocHub.stream.subUpdates.size === 0, 'no subscription left behind')
  doc.destroy()
}
