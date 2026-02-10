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
  if (response.ok) {
    const data = await response.arrayBuffer()
    const decoder = decoding.createDecoder(new Uint8Array(data))
    return decoding.readAny(decoder)
  } else {
    throw new Error('Unexpected error reading from the api: ' + await response.text())
  }
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
 * @param {string} path
 * @param {any} body
 */
const patchYhubRequest = async (path, body) => {
  const encoder = encoding.createEncoder()
  encoding.writeAny(encoder, body)
  const response = await fetch(`http://${utils.yhubHost}${path}`, {
    method: 'PATCH',
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
export const testChangesetRestApi = async tc => {
  const { org, createWsClient } = await utils.createTestCase(tc)
  const { ydoc } = createWsClient()
  ydoc.get().applyDelta(delta.create().insert('hello world')) // change time: 1
  await promise.wait(100)
  ydoc.get().applyDelta(delta.create().delete(6).retain(5).insert('!')) // change time: 2
  await promise.wait(100)
  ydoc.get().applyDelta(delta.create().insert('hi ')) // change time: 3
  await promise.wait(3000)
  // fetch timestamps
  const activity = await fetchYhubResponse(`/activity/${org}/${ydoc.guid}?group=false`)
  console.log('RECEIVED ACTIVITY!!', activity)
  t.assert(activity.length === 3)
  {
    const changeset = await fetchYhubResponse(`/changeset/${org}/${ydoc.guid}?from=${activity[1].from}&to=${activity[1].to}&ydoc=true&delta=true&attributions=true`)
    console.log(changeset)
    console.log('prevDoc: ', JSON.stringify(Y.createDocFromUpdate(changeset.prevDoc).toJSON()))
    console.log('nextDoc: ', JSON.stringify(Y.createDocFromUpdate(changeset.nextDoc).toJSON()))
    console.log('delta: ', JSON.stringify(changeset.delta))
    // @ts-ignore
    t.assert(changeset.delta.children.map(c => c.insert).join('') === 'hello world!')
  }
  { // rollback
    const rollbackResult = await postYhubRequest(`/rollback/${org}/${ydoc.guid}`, { from: activity[1].from, to: activity[1].to }) // undo (delete "hello" & insert "!")
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
  const { ydoc, provider } = await createWsClient({ waitForSync: true, syncAwareness: false })
  ydoc.get().setAttr('key1', 'val1')
  ydoc.get().setAttr('key2', 'val2')
  await promise.wait(1000)
  provider.destroy()
  ydoc.destroy()
  let streamexists = true
  const streamName = stream.encodeRoomName({ org, docid: ydoc.guid, branch: 'main' }, yhub.stream.prefix)
  while (streamexists) {
    streamexists = (await yhub.stream.redis.exists(streamName)) === 1
  }
  const { ydoc: loadedDoc } = await createWsClient({ waitForSync: true, syncAwareness: false })
  t.assert(loadedDoc.get().getAttr('key1') === 'val1')
  t.assert(loadedDoc.get().getAttr('key2') === 'val2')
  let workertasksEmpty = false
  while (!workertasksEmpty) {
    workertasksEmpty = await yhub.stream.redis.xLen(yhub.stream.workerStreamName) === 0
  }
}

/**
 * @param {t.TestCase} tc
 */
export const testYdocRestApi = async tc => {
  const { org, createWsClient } = await utils.createTestCase(tc)
  // Create initial document via websocket
  const { ydoc: initialDoc, provider } = await createWsClient({ waitForSync: true })
  initialDoc.get().applyDelta(delta.create().insert('initial content'))
  await promise.wait(100)
  provider.destroy()

  // Retrieve the document via GET
  const getResponse = await fetchYhubResponse(`/ydoc/${org}/${initialDoc.guid}`)
  t.assert(getResponse.doc instanceof Uint8Array, 'GET response should contain doc as Uint8Array')

  // Apply remote state to a local document and make changes
  const localDoc = new Y.Doc()
  Y.applyUpdate(localDoc, getResponse.doc)
  t.compare(localDoc.get().toDelta(), delta.create().insert('initial content'), 'Local doc should have initial content')

  // Make local changes
  localDoc.get().applyDelta(delta.create().retain(8).insert('new '))
  const update = Y.encodeStateAsUpdate(localDoc)

  // Send update via PATCH
  const patchResponse = await patchYhubRequest(`/ydoc/${org}/${initialDoc.guid}`, { update })
  t.assert(patchResponse.success === true, 'PATCH should return success')

  // Wait for changes to propagate and verify via websocket
  await promise.wait(500)
  const { ydoc: verifyDoc } = await createWsClient({ docid: initialDoc.guid.split('-').pop(), waitForSync: true })
  t.compare(verifyDoc.get().toDelta(), delta.create().insert('initial new content'), 'Document should have updated content')
}
