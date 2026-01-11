import * as Y from 'yjs'
import * as t from 'lib0/testing'
import * as api from '../src/api.js'
import * as encoding from 'lib0/encoding'
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
  await redisClient.connect()
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
    const m = encoding.encode(encoder => {
      encoding.writeVarUint(encoder, 0) // sync protocol
      encoding.writeVarUint(encoder, 2) // update message
      encoding.writeVarUint8Array(encoder, update)
    })
    client.addMessage(room, docid, Buffer.from(m))
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
  ydoc.getMap().set('key1', 'val1')
  ydoc.getMap().set('key2', 'val2')
  const { ydoc: loadedDoc } = await client.getDoc(room, docid)
  t.compare(loadedDoc.getMap().get('key1'), 'val1')
  t.compare(loadedDoc.getMap().get('key2'), 'val2')
}

/**
 * @param {t.TestCase} tc
 */
export const testWorker = async tc => {
  const { client, ydoc, stream, room, docid } = await createTestCase(tc)
  await createWorker()
  ydoc.getMap().set('key1', 'val1')
  ydoc.getMap().set('key2', 'val2')
  let streamexists = true
  while (streamexists) {
    streamexists = (await client.redis.exists(stream)) === 1
  }
  const { ydoc: loadedDoc } = await client.getDoc(room, docid)
  t.assert(loadedDoc.getMap().get('key1') === 'val1')
  t.assert(loadedDoc.getMap().get('key2') === 'val2')
  let workertasksEmpty = false
  while (!workertasksEmpty) {
    workertasksEmpty = await client.redis.xLen(client.redisWorkerStreamName) === 0
  }
}
