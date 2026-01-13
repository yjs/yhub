import * as t from 'lib0/testing'
import * as api from '../src/api.js'
import * as promise from 'lib0/promise'
import * as utils from './utils.js'

/**
 * @param {t.TestCase} tc
 */
export const testSyncAndCleanup = async tc => {
  const removedAfterXTimeouts = 6 // always needs min 2x of minMessageLifetime
  const { createWsClient, worker, redisClient } = await utils.createTestCase(tc)
  const { ydoc: doc1 } = createWsClient('map')
  // doc2: can retrieve changes propagated on stream
  const { ydoc: doc2 } = createWsClient('map')
  await promise.wait(5000)
  doc1.getMap().set('a', 1)
  t.info('docs syncing (0)')
  await utils.waitDocsSynced(doc1, doc2)
  t.info('docs synced (1)')
  const docStreamExistsBefore = await redisClient.exists(api.computeRedisRoomStreamName(tc.testName + '-' + 'map', 'index', 'main', utils.redisPrefix))
  console.log('a:', doc2.getMap().get('a'))
  console.log(doc2.store.clients.size, doc2.store.clients, doc2.store.pendingStructs)
  t.assert(doc2.getMap().get('a') === 1)
  // doc3 can retrieve older changes from stream
  const { ydoc: doc3 } = createWsClient('map')
  await utils.waitDocsSynced(doc1, doc3)
  t.info('docs synced (2)')
  t.assert(doc3.getMap().get('a') === 1)
  await promise.wait(worker.client.redisMinMessageLifetime * removedAfterXTimeouts)
  const docStreamExists = await redisClient.exists(api.computeRedisRoomStreamName(tc.testName + '-' + 'map', 'index', 'main', utils.redisPrefix))
  const workerLen = await redisClient.xLen(utils.redisPrefix + ':worker')
  t.assert(!docStreamExists && docStreamExistsBefore)
  t.assert(workerLen === 0)
  t.info('stream cleanup after initial changes')
  // doc4 can retrieve the document again from MemoryStore
  const { ydoc: doc4 } = createWsClient('map')
  await utils.waitDocsSynced(doc3, doc4)
  t.info('docs synced (3)')
  t.assert(doc3.getMap().get('a') === 1)
  const memRetrieved = await utils.storage.retrieveDoc(tc.testName + '-' + 'map', 'index')
  t.assert(memRetrieved?.references.length === 1)
  t.info('doc retrieved')
  // now write another updates that the worker will collect
  doc1.getMap().set('a', 2)
  await promise.wait(worker.client.redisMinMessageLifetime * removedAfterXTimeouts)
  t.assert(doc2.getMap().get('a') === 2)
  const memRetrieved2 = await utils.storage.retrieveDoc(tc.testName + '-' + 'map', 'index')
  t.info('map retrieved')
  // should delete old references
  t.assert(memRetrieved2?.references.length === 1)
  await promise.all(utils.prevClients.reverse().map(c => c.destroy()))
}

/**
 * @param {t.TestCase} tc
 */
export const testGcNonGcDocs = async tc => {
  const { createWsClient } = await utils.createTestCase(tc)
  const { ydoc: ydocGc } = createWsClient('gctest')
  ydocGc.getMap().set('a', 1)
  await promise.wait(500)
  ydocGc.getMap().set('a', 2)
  await promise.wait(100)
  const { ydoc: ydocNoGc } = createWsClient('gctest', { gc: false })
  await utils.waitDocsSynced(ydocGc, ydocNoGc)
  t.assert(ydocNoGc.getMap().get('a') === 2)
  // check that content was not gc'd
  t.assert(ydocNoGc.getMap()._map.get('a')?.left?.content.getContent()[0] === 1)
}
