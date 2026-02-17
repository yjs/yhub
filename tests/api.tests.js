import * as Y from '@y/y'
import * as t from 'lib0/testing'
import * as promise from 'lib0/promise'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as utils from './utils.js'
import * as delta from 'lib0/delta'
import * as stream from '../src/stream.js'
import * as array from 'lib0/array'
import * as math from 'lib0/math'
import * as fs from 'node:fs'
import * as prng from 'lib0/prng'

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
  console.log('creating documents')
  ydoc.get().applyDelta(delta.create().insert('hello world')) // change time: 1
  await promise.wait(100)
  ydoc.get().applyDelta(delta.create().delete(6).retain(5).insert('!')) // change time: 2
  await promise.wait(100)
  ydoc.get().applyDelta(delta.create().insert('hi ')) // change time: 3
  await promise.wait(3000)
  // fetch timestamps
  console.log('finished creating documents - fetching activity')
  const activity = await fetchYhubResponse(`/activity/${org}/${ydoc.guid}?group=false`)
  console.log('received activity', activity)
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
  t.info('created doc')
  provider.destroy()
  ydoc.destroy()
  const streamName = stream.encodeRoomName({ org, docid: ydoc.guid, branch: 'main' }, yhub.stream.prefix)
  console.info('waiting for stream to be deleted', { conf: yhub.conf.redis, streamName })
  await promise.untilAsync(async () => ((await yhub.stream.redis.exists(streamName)) === 1), yhub.conf.redis.minMessageLifetime * 9)
  t.info('stream deleted')
  const { ydoc: loadedDoc } = await createWsClient({ waitForSync: true, syncAwareness: false })
  t.assert(loadedDoc.get().getAttr('key1') === 'val1')
  t.assert(loadedDoc.get().getAttr('key2') === 'val2')
  let workertasksEmpty = false
  t.info('waiting for tasks to be empty')
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
  t.compare(verifyDoc.get().toDelta(), delta.create(delta.$deltaAny).insert('initial new content'), 'Document should have updated content')
}

/**
 * @param {t.TestCase} tc
 */
export const testCustomAttributionsRollback = async tc => {
  const { org, createWsClient } = await utils.createTestCase(tc)
  // Create initial document via websocket
  const { ydoc: initialDoc, provider } = await createWsClient({ waitForSync: true })
  initialDoc.get().applyDelta(delta.create().insert('hello world'))
  await promise.wait(100)
  provider.destroy()

  // Fetch doc state, apply change 1 with custom attribution source=import
  const get1 = await fetchYhubResponse(`/ydoc/${org}/${initialDoc.guid}`)
  const doc1 = new Y.Doc()
  Y.applyUpdate(doc1, get1.doc)
  doc1.get().applyDelta(delta.create().retain(5).insert(' beautiful'))
  const patchRes1 = await patchYhubRequest(`/ydoc/${org}/${initialDoc.guid}`, {
    update: Y.encodeStateAsUpdate(doc1),
    customAttributions: [{ k: 'source', v: 'userA' }]
  })
  t.assert(patchRes1.success === true)
  await promise.wait(500)

  // Fetch doc state, apply change 2 with custom attribution source=manual
  const get2 = await fetchYhubResponse(`/ydoc/${org}/${initialDoc.guid}`)
  const doc2 = new Y.Doc()
  Y.applyUpdate(doc2, get2.doc)
  // doc should now be "hello beautiful world"
  t.compare(doc2.get().toDelta(), delta.create(delta.$deltaAny).insert('hello beautiful world'))
  doc2.get().applyDelta(delta.create().insert('hey '))
  const patchRes2 = await patchYhubRequest(`/ydoc/${org}/${initialDoc.guid}`, {
    update: Y.encodeStateAsUpdate(doc2),
    customAttributions: [{ k: 'source', v: 'userB' }]
  })
  t.assert(patchRes2.success === true)
  await promise.wait(500)

  // Verify current state: "hey hello beautiful world"
  const { ydoc: beforeRollback } = await createWsClient({ waitForSync: true })
  t.compare(beforeRollback.get().toDelta(), delta.create(delta.$deltaAny).insert('hey hello beautiful world'))

  // Rollback without any filter should return an error
  const emptyRollback = await postYhubRequest(`/rollback/${org}/${initialDoc.guid}`, {})
  t.assert(emptyRollback.error != null, 'Rollback without filters should return an error')

  // Rollback only changes with source=userA
  const rollbackResult = await postYhubRequest(`/rollback/${org}/${initialDoc.guid}`, {
    withCustomAttributions: [{ k: 'source', v: 'userA' }]
  })
  t.assert(rollbackResult.success === true)
  await promise.wait(3000)

  // Verify: " beautiful" should be undone, "hey " should remain
  const { ydoc: afterRollback } = await createWsClient({ waitForSync: true })
  console.log('after rollback json', afterRollback.get().toDelta().toJSON())
  t.compare(afterRollback.get().toDelta(), delta.create(delta.$deltaAny).insert('hey hello world'))

  // Verify activity API filtering by custom attributions
  const activityUserA = await fetchYhubResponse(`/activity/${org}/${initialDoc.guid}?group=false&withCustomAttributions=source:userA&delta=true`)
  t.assert(activityUserA.length === 1)
  t.compare(activityUserA[0].delta.children[1].insert, ' beautiful')
}

const logMemoryUsed = (prefix = '') => {
  const heapUsed = process.memoryUsage().heapUsed
  console.log(`${prefix.length === 0 ? '' : `[${prefix}] `}Heap used: ${(heapUsed / 1024 / 1024).toFixed(2)} MB`)
  return heapUsed
}

const ydocBinLarge = (() => {
  const ydoc = new Y.Doc()
  for (let i = 0; i < 10_000; i++) {
    ydoc.get('attrs').setAttr('' + i, i)
  }
  return Y.encodeStateAsUpdate(ydoc)
})()

console.log('size of large doc', ydocBinLarge.byteLength)

/**
 * @param {t.TestCase} tc
 */
export const testManyDistinctConnectionsMemoryDebug = async tc => {
  const Iterations = 5
  const NDocs = 100
  const gc = global.gc
  t.skip(gc == null)
  t.assert(gc)
  const { createWsClient, yhub } = await utils.createTestCase(tc)
  const beforeTaskConcurrency = yhub.conf.worker.taskConcurrency
  yhub.conf.worker.taskConcurrency = 500
  gc()
  let maxMemory = 0
  const beforeMemory = logMemoryUsed('before memory')
  try {
    for (let currIteration = 0; currIteration < Iterations; currIteration++) {
      t.info('starting iteration #' + currIteration)
      await t.measureTimeAsync(`time to sync ${NDocs} docs`, async () => {
        await promise.all(array.unfold(NDocs, async (i) => {
          const r = await createWsClient({ waitForSync: true, syncAwareness: false, docid: 'doc-' + i })
          Y.applyUpdate(r.ydoc, ydocBinLarge)
          r.ydoc.get().insert(0, [prng.utf16String(tc.prng)])
          return r
        }))
        await t.measureTimeAsync('time to pull last doc', async () => {
          const docBase = createWsClient({ syncAwareness: false, docid: 'doc-' + (NDocs - 1) })
          await promise.untilAsync(async () => {
            // console.log('inserted elems', docBase.ydoc.get().length, docBase.ydoc.get().toJSON())
            return docBase.ydoc.get().length === currIteration + 1
          })
        })
      })
      const afterMemory = logMemoryUsed('after updates memory')
      maxMemory = math.max(maxMemory, afterMemory)
      utils.cleanPreviousClients()
      await promise.wait(100)
      gc()
      logMemoryUsed('cleaning up memory - iteration #' + currIteration)
    }
    await promise.wait(yhub.conf.redis.minMessageLifetime)
    await t.measureTimeAsync('time to process all tasks', async () => {
      await utils.waitTasksProcessed(yhub)
    })
    gc()
    const cleanedUpMemory = logMemoryUsed('cleaned up memory')
    console.log({ maxMemory: maxMemory / 1000 / 1000, beforeMemory: beforeMemory / 1000 / 1000, cleanedUpMemory: cleanedUpMemory / 1000 / 1000, diff: (cleanedUpMemory - beforeMemory) / 1000 / 1000 })
    const heapSizeIncrease = cleanedUpMemory - beforeMemory
    t.assert(heapSizeIncrease < (maxMemory - beforeMemory) * 0.2) // memory increased by max 20%
  } finally {
    yhub.conf.worker.taskConcurrency = beforeTaskConcurrency
  }
}

/**
 * @param {t.TestCase} tc
 */
export const testLargeDoc = async tc => {
  const { createWsClient, yhub, org } = await utils.createTestCase(tc)
  const prevMinMessageLifletime = yhub.conf.redis.minMessageLifetime
  yhub.conf.redis.minMessageLifetime = 1000_000
  const docid = 'large-doc'
  let docidFull = docid
  try {
    {
      const c1 = await createWsClient({ waitForSync: true, syncAwareness: true, docid })
      docidFull = c1.ydoc.guid
      const largeDocPath = new URL('../large.test.ydoc', import.meta.url)
      let largeDocBin
      if (fs.existsSync(largeDocPath)) {
        largeDocBin = new Uint8Array(fs.readFileSync(largeDocPath))
      } else {
        const tmpDoc = new Y.Doc()
        for (let i = 0; i < 1000_000; i++) {
          tmpDoc.get().insert(0, [{ i, somestring: prng.word(tc.prng, 30) }])
        }
        largeDocBin = Y.encodeStateAsUpdate(tmpDoc)
        tmpDoc.destroy()
      }
      console.log(`binary encoded ydoc size: ${largeDocBin.byteLength}`)
      t.measureTime('loading large doc to memory', () => {
        const beforeMemory = logMemoryUsed('before loading large ydoc')
        Y.applyUpdate(c1.ydoc, largeDocBin)
        const afterMem = logMemoryUsed('after loading large ydoc')
        console.info('memory used for large doc: ', (afterMem - beforeMemory) / 1000 / 1000, 'mb')
      })
      await t.measureTimeAsync('sync e2e with remote client', async () => {
        const c2 = await createWsClient({ waitForSync: true, syncAwareness: true, docid })
        t.info('waiting for sync with other client')
        await promise.until(360_000, () => c2.ydoc.store.clients.size > 0)
        c2.ydoc.store.clients.forEach((c, clientid) => {
          console.log('c2 client len', { len: c.length, clientid })
        })
        console.log('c2 url', c2.provider.url)
        t.assert(c2.ydoc.store.clients.size > 0)
      })
      logMemoryUsed('synced e2e two large ydocs')
    }
    utils.cleanPreviousClients()
    await promise.wait(1000)
    await t.measureTimeAsync('fetching /activity from test api', async () => {
      const activity = await fetchYhubResponse(`/activity/${org}/${docidFull}?group=true`)
      logMemoryUsed('fetched activity')
      console.log({ activity })
      t.assert(activity.length > 0)
    })
  } finally {
    yhub.conf.redis.minMessageLifetime = prevMinMessageLifletime
  }
}
