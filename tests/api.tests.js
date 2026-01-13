import * as Y from '@y/y'
import * as t from 'lib0/testing'
import * as api from '../src/api.js'
import * as promise from 'lib0/promise'
import * as redis from 'redis'
import { prevClients, storage } from './utils.js'

const redisPrefix = 'ytests'

/**
 * @param {t.TestCase} tc
 */
const createTestCase = async tc => {
  await promise.all(prevClients.map(c => c.destroy()))
  prevClients.length = 0
  const redisClient = redis.createClient({ url: api.redisUrl })
  await promise.untilAsync(async () => {
    try {
      await redisClient.connect()
    } catch (err) {
      console.warn(`Can't connect to redis! url: ${api.redisUrl}`)
      return false
    }
    return true
  }, 10000)
  // flush existing content
  const keysToDelete = await redisClient.keys(redisPrefix + ':*')
  keysToDelete.length > 0 && await redisClient.del(keysToDelete)
  await redisClient.quit()
  const client = await api.createApiClient(storage, redisPrefix)
  prevClients.push(client)
  const room = tc.testName
  const docid = 'main'
  const branch = 'main'
  const stream = api.computeRedisRoomStreamName(room, docid, branch, redisPrefix)
  const ydoc = new Y.Doc()
  ydoc.on('update', update => {
    client.addMessage(room, docid, { type: 'update:v1', attributions: undefined, update })
  })
  return {
    client,
    ydoc,
    room,
    docid,
    stream
  }
}

const createWorker = async () => {
  const worker = await api.createWorker(storage, redisPrefix, {})
  prevClients.push(worker.client)
  return worker
}

/**
 * @param {t.TestCase} tc
 */
export const testUpdateApiMessages = async tc => {
  const { client, ydoc, room, docid } = await createTestCase(tc)
  ydoc.get().setAttr('key1', 'val1')
  ydoc.get().setAttr('key2', 'val2')
  const { ydoc: loadedDoc } = await client.getDoc(room, docid)
  t.compare(loadedDoc.get().getAttr('key1'), 'val1')
  t.compare(loadedDoc.get().getAttr('key2'), 'val2')
}

/**
 * @param {t.TestCase} tc
 */
export const testWorker = async tc => {
  const { client, ydoc, stream, room, docid } = await createTestCase(tc)
  await createWorker()
  ydoc.get().setAttr('key1', 'val1')
  ydoc.get().setAttr('key2', 'val2')
  let streamexists = true
  while (streamexists) {
    streamexists = (await client.redis.exists(stream)) === 1
  }
  const { ydoc: loadedDoc } = await client.getDoc(room, docid)
  t.assert(loadedDoc.get().getAttr('key1') === 'val1')
  t.assert(loadedDoc.get().getAttr('key2') === 'val2')
  let workertasksEmpty = false
  while (!workertasksEmpty) {
    workertasksEmpty = await client.redis.xLen(client.redisWorkerStreamName) === 0
  }
}
