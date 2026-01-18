import * as Y from '@y/y'
import * as t from 'lib0/testing'
import * as api from '../src/api.js'
import * as promise from 'lib0/promise'
import * as redis from 'redis'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as utils from './utils.js'
import * as delta from 'lib0/delta'

const redisPrefix = 'ytests'

/**
 * @param {t.TestCase} tc
 */
const createTestCase = async tc => {
  await promise.all(utils.prevClients.map(c => c.destroy()))
  utils.prevClients.length = 0
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
  const client = await api.createApiClient(utils.storage, redisPrefix)
  utils.prevClients.push(client)
  const room = tc.testName
  const docid = 'index'
  const branch = 'main'
  const stream = api.computeRedisRoomStreamName(room, docid, branch, redisPrefix)
  const ydoc = new Y.Doc()
  let currSimTime = 1
  ydoc.on('update', update => {
    client.addMessage(room, docid, { type: 'update:v1', attributions: Y.encodeContentMap(Y.createContentMapFromContentIds(Y.createContentIdsFromUpdate(update), [Y.createContentAttribute('insert', `testcase:${tc.testName}`), Y.createContentAttribute('insertAt', currSimTime)], [Y.createContentAttribute('delete', `testcase:${tc.testName}`), Y.createContentAttribute('deleteAt', currSimTime)])), update })
    currSimTime++
  })
  const server = await utils.createServer()
  return {
    client,
    ydoc,
    room,
    docid,
    stream,
    server
  }
}

/**
 * @param {string} path
 */
const fetchYhubResponse = async path => {
  const response = await fetch(`http://${utils.yhubHost}${path}`)
  const data = await response.arrayBuffer()
  const decoder = decoding.createDecoder(new Uint8Array(data))
  return decoding.readAny(decoder)
}

/**
 * @param {string} path
 * @param {any} body
 */
const postYhubRequest = async (path, body) => {
  const encoder = encoding.createEncoder()
  encoding.writeAny(encoder, body)
  const response = await fetch(`http://${utils.yhubHost}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: encoding.toUint8Array(encoder)
  })
  const data = await response.arrayBuffer()
  const decoder = decoding.createDecoder(new Uint8Array(data))
  return decoding.readAny(decoder)
}

/**
 * @param {t.TestCase} tc
 */
export const testHistoryRestApi = async tc => {
  const { client, ydoc, room, docid } = await createTestCase(tc)
  ydoc.get().applyDelta(delta.create().insert('hello world')) // change time: 1
  ydoc.get().applyDelta(delta.create().delete(6).retain(5).insert('!')) // change time: 2
  ydoc.get().applyDelta(delta.create().insert('hi ')) // change time: 3
  await promise.wait(3000)
  {
    // fetch timestamps
    const { timestamps } = await fetchYhubResponse(`/timestamps/${room}`)
    console.log('RECEIVED TIMESTAMPS!!', timestamps)
    t.compare(timestamps, [1, 2, 3])
  }
  {
    const history = await fetchYhubResponse(`/history/${room}?from=2&to=2&ydoc=true&delta=true&attributions=true`)
    console.log(history)
    console.log('prevDoc: ', JSON.stringify(Y.createDocFromUpdate(history.prevDoc).toJSON()))
    console.log('nextDoc: ', JSON.stringify(Y.createDocFromUpdate(history.nextDoc).toJSON()))
    console.log('delta: ', JSON.stringify(history.delta))
  }
  { // rollback
    const rollbackResult = await postYhubRequest(`/rollback/${room}`, { from: 2, to: 2 }) // undo (delete "hello" & insert "!")
    console.log(rollbackResult)
    await promise.wait(3000)
    const xdoc = await client.getDoc(room, docid)
    const rollbackContent = xdoc.ydoc.get().toDelta()
    console.log(rollbackContent.toJSON())
    t.compare(rollbackContent, delta.create().insert('hello hi world'))
  }
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
  await utils.createWorker()
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
