import * as t from 'lib0/testing'
import * as promise from 'lib0/promise'
import * as encoding from 'lib0/encoding'
import * as utils from './utils.js'

/**
 * @param {t.TestCase} tc
 */
export const testSyncAndCleanup = async tc => {
  const removedAfterXTimeouts = 6 // always needs min 2x of minMessageLifetime
  const { createWsClient, yhub, defaultStream, defaultRoom } = await utils.createTestCase(tc)
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
  const { references } = await yhub.getDoc(defaultRoom, { references: true, gc: true })
  t.assert(references.length === 1 * 2)
  t.info('doc retrieved')
  // now write another updates that the worker will collect
  doc1.get().setAttr('a', 2)
  await promise.wait(yhub.stream.minMessageLifetime * removedAfterXTimeouts)
  t.assert(doc2.get().getAttr('a') === 2)
  const { references: references2 } = await yhub.getDoc(defaultRoom, { references: true, gc: true })
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
  const { createWsClient, yhub, defaultRoom } = await utils.createTestCase(tc)
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
  await yhub.stream.addMessage(defaultRoom, { type: 'awareness:v1', update: encodeOneEntry(fakeClientid, 1, { user: 'alice' }) })
  await yhub.stream.addMessage(defaultRoom, { type: 'awareness:v1', update: encodeOneEntry(fakeClientid, 2, null) })

  const { provider } = await createWsClient({ waitForSync: true })
  await promise.wait(200) // give the awareness snapshot a moment to be applied

  t.assert(!provider.awareness.states.has(fakeClientid), 'disconnected client absent from awareness.states')
  const meta = provider.awareness.meta.get(fakeClientid)
  t.assert(meta?.clock === 2, 'disconnect recorded in awareness.meta with preserved clock')
}

/**
 * A room that only ever receives awareness messages must NOT be persisted. Awareness carries
 * no document content, so it must not advance the compaction guard (which now compares against
 * `lastUpdateClock`, not the awareness-inclusive `lastClock`). The stream is still trimmed and
 * cleaned up once the awareness entries age past `minMessageLifetime`.
 *
 * @param {t.TestCase} tc
 */
export const testAwarenessOnlyDoesNotPersist = async tc => {
  const { yhub, defaultRoom, defaultStream } = await utils.createTestCase(tc)
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
  await yhub.stream.addMessage(defaultRoom, { type: 'awareness:v1', update: encodeOneEntry(0xc0ffee, 1, { user: 'alice' }) })
  await yhub.stream.addMessage(defaultRoom, { type: 'awareness:v1', update: encodeOneEntry(0xc0ffee, 2, { user: 'alice', typing: true }) })

  t.info('waiting for compaction to run and the stream to be cleaned up')
  await utils.waitTasksProcessed(yhub)

  t.info('asserting nothing was persisted and the stream was trimmed away')
  const persisted = await yhub.persistence.retrieveDoc(defaultRoom, { gc: true })
  t.assert(persisted.lastClock === '0', 'awareness-only room must not be persisted')
  t.assert(persisted.gcDoc.length === 0, 'no gc doc assets should exist for an awareness-only room')
  const streamExists = await yhub.stream.redis.exists(defaultStream)
  t.assert(!streamExists, 'awareness-only stream should be trimmed and deleted (no persist, no infinite re-enqueue)')
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
