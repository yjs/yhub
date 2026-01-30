import * as Y from '@y/y'
import * as t from 'lib0/testing'
import * as promise from 'lib0/promise'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as utils from './utils.js'
import * as delta from 'lib0/delta'
import * as stream from '../src/stream.js'

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
  const { org, createWsClient } = await utils.createTestCase(tc)
  const { ydoc } = createWsClient()
  ydoc.get().applyDelta(delta.create().insert('hello world')) // change time: 1
  ydoc.get().applyDelta(delta.create().delete(6).retain(5).insert('!')) // change time: 2
  ydoc.get().applyDelta(delta.create().insert('hi ')) // change time: 3
  await promise.wait(3000)
  // fetch timestamps
  const { timestamps } = await fetchYhubResponse(`/timestamps/${org}/${ydoc.guid}`)
  console.log('RECEIVED TIMESTAMPS!!', timestamps)
  t.assert(timestamps.length === 3)
  {
    const history = await fetchYhubResponse(`/history/${org}/${ydoc.guid}?from=2&to=2&ydoc=true&delta=true&attributions=true`)
    console.log(history)
    console.log('prevDoc: ', JSON.stringify(Y.createDocFromUpdate(history.prevDoc).toJSON()))
    console.log('nextDoc: ', JSON.stringify(Y.createDocFromUpdate(history.nextDoc).toJSON()))
    console.log('delta: ', JSON.stringify(history.delta))
  }
  { // rollback
    const rollbackResult = await postYhubRequest(`/rollback/${org}/${ydoc.guid}`, { from: timestamps[1], to: timestamps[1] }) // undo (delete "hello" & insert "!")
    console.log(rollbackResult)
    await promise.wait(3000)
    const { ydoc: xdoc } = await createWsClient({ waitForSync: true })
    const rollbackContent = xdoc.get().toDelta()
    console.log(rollbackContent.toJSON())
    t.compare(rollbackContent, delta.create().insert('hello hi world'))
  }
}

/**
 * @param {t.TestCase} tc
 */
export const testUpdateApiMessages = async tc => {
  const { createWsClient } = await utils.createTestCase(tc)
  const { ydoc } = await createWsClient({ waitForSync: true })
  ydoc.get().setAttr('key1', 'val1')
  ydoc.get().setAttr('key2', 'val2')
  const { ydoc: loadedDoc } = await createWsClient({ waitForSync: true })
  t.compare(loadedDoc.get().getAttr('key1'), 'val1')
  t.compare(loadedDoc.get().getAttr('key2'), 'val2')
}

/**
 * @param {t.TestCase} tc
 */
export const testWorker = async tc => {
  const { yhub, createWsClient, org } = await utils.createTestCase(tc)
  const { ydoc } = createWsClient()
  ydoc.get().setAttr('key1', 'val1')
  ydoc.get().setAttr('key2', 'val2')
  let streamexists = true
  const streamName = stream.encodeRoomName({ org, docid: ydoc.guid, branch: 'main' }, yhub.stream.prefix)
  while (streamexists) {
    streamexists = (await yhub.stream.redis.exists(streamName)) === 1
  }
  const { ydoc: loadedDoc } = await createWsClient({ waitForSync: true })
  t.assert(loadedDoc.get().getAttr('key1') === 'val1')
  t.assert(loadedDoc.get().getAttr('key2') === 'val2')
  let workertasksEmpty = false
  while (!workertasksEmpty) {
    workertasksEmpty = await yhub.stream.redis.xLen(yhub.stream.workerStreamName) === 0
  }
}
