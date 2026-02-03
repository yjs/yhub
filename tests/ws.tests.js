import * as t from 'lib0/testing'
import * as promise from 'lib0/promise'
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
  await promise.wait(5000)
  doc1.get().setAttr('a', 1)
  t.info('docs syncing (0)')
  await utils.waitDocsSynced(doc1, doc2)
  await promise.wait(5000)
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
  debugger
  t.assert(references.length === 1)
  t.info('doc retrieved')
  // now write another updates that the worker will collect
  doc1.get().setAttr('a', 2)
  await promise.wait(yhub.stream.minMessageLifetime * removedAfterXTimeouts)
  t.assert(doc2.get().getAttr('a') === 2)
  const { references: references2 } = await yhub.getDoc(defaultRoom, { references: true, gc: true })
  t.info('map retrieved')
  // should delete old references
  t.assert(references2.length === 1)
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
