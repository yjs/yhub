import * as Y from '@y/y'
import * as t from 'lib0/testing'
import * as promise from 'lib0/promise'
import * as object from 'lib0/object'
import * as utils from './utils.js'
import * as stream from '../src/stream.js'

/**
 * Every hub created here runs on its own redis prefix. The shared test hub runs a worker with
 * `taskConcurrency: 500` on `yhub:testing`, so it would claim any task we park - and a document
 * stream we leave behind would make `waitTasksProcessed` spin for 150s in every following test.
 *
 * @param {string} prefix
 */
const clearPrefix = async prefix => {
  const redis = utils.yhub.stream.redis
  const keys = await redis.keys(`${prefix}:*`)
  if (keys.length > 0) await redis.del(keys)
}

/**
 * @param {object} conf
 * @param {number} conf.taskDebounce
 * @param {number} [conf.maxTaskDuration]
 * @param {(event: { docRef: import('../src/types.js').DocRef, timestamp: number }) => void} [conf.taskStart]
 * @param {(event: { docRef: import('../src/types.js').DocRef, duration: number, error: Error|null }) => void} [conf.taskComplete]
 * @param {string} prefix
 */
const createWorkerHub = ({ taskDebounce, maxTaskDuration, taskStart, taskComplete }, prefix) =>
  utils.createTestHub({
    redis: object.assign({}, utils.yhub.conf.redis, { prefix, taskDebounce, minMessageLifetime: 100 }),
    maxTaskDuration,
    worker: { taskConcurrency: 10, events: { taskStart, taskComplete } }
  })

/**
 * @param {import('../src/index.js').YHub} hub
 * @param {import('../src/types.js').DocRef} docRef
 * @param {string} content
 */
const seedDocRef = (hub, docRef, content) => {
  const ydoc = new Y.Doc()
  ydoc.get('text').insert(0, content)
  const update = Y.encodeStateAsUpdate(ydoc)
  const contentmap = Y.encodeContentMap(Y.createContentMapFromContentIds(
    Y.createContentIdsFromUpdate(update),
    [Y.createContentAttribute('insert', 'tester')],
    [Y.createContentAttribute('delete', 'tester')]
  ))
  return hub.stream.addMessage(docRef, { type: 'ydoc:update:v1', update, contentmap })
}

/**
 * Replace `computePool.mergeUpdates` so that compacting `docRef` blocks. Only the gc'd merge is
 * delayed - `getDoc` merges the gc and the nongc doc, so delaying both would double the wait.
 *
 * @param {import('../src/index.js').YHub} hub
 * @param {import('../src/types.js').DocRef} docRef
 * @param {Promise<void>} blocked resolves when the merge may proceed
 */
const blockCompaction = (hub, docRef, blocked) => {
  const mergeUpdates = hub.computePool.mergeUpdates.bind(hub.computePool)
  hub.computePool.mergeUpdates = async (gc, updates, logContext = {}, prune) => {
    if (gc && logContext.docRef?.docid === docRef.docid) await blocked
    return mergeUpdates(gc, updates, logContext, prune)
  }
}

/**
 * @param {import('../src/index.js').YHub} hub
 */
const waitDrained = hub => promise.untilAsync(async () => {
  const [pendingTasks, activeStreams] = await promise.all([hub.stream.getPendingTasksSize(), hub.stream.getActiveStreams()])
  return pendingTasks === 0 && activeStreams.length === 0
}, 30000, 100)

/**
 * A compaction that runs much longer than `redis.taskDebounce` must keep its lease: it may
 * neither be handed back to its own worker nor picked up by another one. And while it runs, the
 * worker must keep claiming and completing tasks for other documents.
 *
 * @param {t.TestCase} tc
 */
export const testTaskLeaseSurvivesLongCompute = async tc => {
  const prefix = 'yhub:testing:lease'
  const taskDebounce = 1000
  await clearPrefix(prefix)
  /**
   * @type {Array<string>}
   */
  const started = []
  /**
   * @type {Array<string>}
   */
  const completed = []
  const hub = await createWorkerHub({
    taskDebounce,
    taskStart: ({ docRef }) => started.push(docRef.docid),
    taskComplete: ({ docRef }) => completed.push(docRef.docid)
  }, prefix)
  const slowDocRef = { org: utils.defaultOrg, docid: tc.testName + '-slow', branch: 'main' }
  const fastDocRef = { org: utils.defaultOrg, docid: tc.testName + '-fast', branch: 'main' }
  /**
   * @type {() => void}
   */
  let unblock = () => {}
  blockCompaction(hub, slowDocRef, promise.create(resolve => { unblock = () => resolve(undefined) }))
  /**
   * @type {Array<string>}
   */
  const stored = []
  const store = hub.persistence.store.bind(hub.persistence)
  hub.persistence.store = (docRef, doc) => { stored.push(docRef.docid); return store(docRef, doc) }

  await seedDocRef(hub, slowDocRef, 'slow')
  const slowTaskId = /** @type {string} */ ((await utils.yhub.stream.redis.xRange(hub.stream.workerStreamName, '-', '+')).find(e => e.message.compact === stream.encodeRoomName(slowDocRef, prefix))?.id)
  t.assert(slowTaskId != null, 'seeding enqueued a compact task for the slow document')
  await promise.untilAsync(() => started.length === 1, 10000, 50)

  // the slow compaction is now running. Hold it for 5x the lease - scaled down from the
  // "5 minutes" in the original @todo, which is 2.5x the production taskDebounce.
  const blockUntil = Date.now() + taskDebounce * 5
  while (Date.now() < blockUntil) {
    await promise.wait(200)
    const pending = await utils.yhub.stream.redis.xPendingRange(hub.stream.workerStreamName, hub.stream.workerGroupName, '-', '+', 100)
    const slow = pending.find(p => p.id === slowTaskId)
    t.assert(slow != null, 'the slow task is still pending')
    t.assert(slow?.consumer === hub.stream.consumername, 'the slow task is still owned by its worker')
    t.assert(/** @type {number} */ (slow?.millisecondsSinceLastDelivery) < taskDebounce, 'the lease of the slow task is renewed before it goes stale')
    // 1 delivery to the "pending" consumer that parks new tasks + 1 for the claim. Renewals use
    // XCLAIM JUSTID, which doesn't count - so anything above 2 means the task was re-delivered.
    t.assert(slow?.deliveriesCounter === 2, 'the slow task was never re-delivered')
  }

  // the claim loop kept working while the slow document was blocked
  await seedDocRef(hub, fastDocRef, 'fast')
  await promise.untilAsync(() => completed.includes(fastDocRef.docid), 10000, 50)
  t.assert(!completed.includes(slowDocRef.docid), 'the slow document is still being compacted')

  unblock()
  await waitDrained(hub)
  t.compare(started.filter(docid => docid === slowDocRef.docid).length, 1, 'the slow document was compacted exactly once')
  t.compare(stored.filter(docid => docid === slowDocRef.docid).length, 1, 'the slow document was persisted exactly once')
  const { gcDoc } = await hub.persistence.retrieveDoc(slowDocRef, { gc: true })
  const restored = new Y.Doc()
  gcDoc.forEach(update => Y.applyUpdate(restored, update))
  t.compare(restored.get('text').toString(), 'slow', 'the slow document was persisted correctly')
  hub.stopWorker()
}

/**
 * `destroy` lets a running compaction finish, keeping its lease alive meanwhile so that no other
 * worker reclaims it, and is over as soon as the task is done - not only after `drainMs`.
 *
 * @param {t.TestCase} tc
 */
export const testDestroyDrainsRunningTask = async tc => {
  const prefix = 'yhub:testing:drain'
  const taskDebounce = 1000
  await clearPrefix(prefix)
  /**
   * @type {Array<string>}
   */
  const started = []
  const hub = await createWorkerHub({ taskDebounce, taskStart: ({ docRef }) => started.push(docRef.docid) }, prefix)
  const docRef = { org: utils.defaultOrg, docid: tc.testName + '-index', branch: 'main' }
  /**
   * @type {() => void}
   */
  let unblock = () => {}
  blockCompaction(hub, docRef, promise.create(resolve => { unblock = () => resolve(undefined) }))
  await seedDocRef(hub, docRef, 'drained')
  await promise.untilAsync(() => started.length === 1, 10000, 50)

  let destroyed = false
  const destroying = hub.destroy({ drainMs: 60_000 }).then(() => { destroyed = true })
  // hold the compaction for 3x the lease while the worker drains
  const blockUntil = Date.now() + taskDebounce * 3
  while (Date.now() < blockUntil) {
    await promise.wait(200)
    const [task] = await utils.yhub.stream.redis.xPendingRange(hub.stream.workerStreamName, hub.stream.workerGroupName, '-', '+', 10)
    t.assert(task?.consumer === hub.stream.consumername, 'the draining task is still owned by its worker')
    t.assert(/** @type {number} */ (task?.millisecondsSinceLastDelivery) < taskDebounce, 'the lease of the draining task is renewed')
  }
  t.assert(!destroyed, 'destroy waits for the running task')
  const unblockedAt = Date.now()
  unblock()
  await destroying
  t.assert(Date.now() - unblockedAt < 5000, 'destroy is over once the task is done')
  // the hub is gone - read back through the shared one, same database
  const { gcDoc } = await utils.yhub.persistence.retrieveDoc(docRef, { gc: true })
  const restored = new Y.Doc()
  gcDoc.forEach(update => Y.applyUpdate(restored, update))
  t.compare(restored.get('text').toString(), 'drained', 'the drained task was persisted')
  await clearPrefix(prefix)
}

/**
 * A compaction that hangs where the compute pool can't kill it - a wedged s3 or postgres socket -
 * is abandoned by the worker after `maxTaskDuration`. It stops being renewed, goes stale, and
 * another worker picks it up: lease renewal must never make a document permanently unreclaimable.
 *
 * @param {t.TestCase} tc
 */
export const testHangingTaskIsAbandonedAndReclaimed = async tc => {
  const prefix = 'yhub:testing:stuck'
  const taskDebounce = 1000
  await clearPrefix(prefix)
  /**
   * @type {Array<string>}
   */
  const startedA = []
  const hubA = await createWorkerHub({ taskDebounce, maxTaskDuration: 500, taskStart: ({ docRef }) => startedA.push(docRef.docid) }, prefix)
  const docRef = { org: utils.defaultOrg, docid: tc.testName + '-index', branch: 'main' }
  // block outside the compute pool: the merge never reaches a worker thread, so nothing can kill
  // it and only the worker's own maxTaskDuration bound applies
  blockCompaction(hubA, docRef, promise.create(() => {}))
  /**
   * @type {Array<string>}
   */
  const storedA = []
  const storeA = hubA.persistence.store.bind(hubA.persistence)
  hubA.persistence.store = (r, doc) => { storedA.push(r.docid); return storeA(r, doc) }

  await seedDocRef(hubA, docRef, 'stuck')
  await promise.untilAsync(() => startedA.length === 1, 10000, 50)
  // once abandoned, the lease is no longer renewed and the entry idles towards taskDebounce
  await promise.untilAsync(async () => {
    const pending = await utils.yhub.stream.redis.xPendingRange(hubA.stream.workerStreamName, hubA.stream.workerGroupName, '-', '+', 10)
    return pending.length === 1 && pending[0].millisecondsSinceLastDelivery > 500
  }, 10000, 50)
  // a real deployment keeps hubA around and it would keep retrying the document. Take it out here so
  // that it can't race hubB for the task it just gave up on.
  hubA.stopWorker()

  // a second worker joins and reclaims the stale task
  const hubB = await createWorkerHub({ taskDebounce }, prefix)
  await waitDrained(hubB)
  t.compare(storedA, [], 'the worker that hung never persisted anything')
  const { gcDoc } = await hubB.persistence.retrieveDoc(docRef, { gc: true })
  const restored = new Y.Doc()
  gcDoc.forEach(update => Y.applyUpdate(restored, update))
  t.compare(restored.get('text').toString(), 'stuck', 'the reclaimed document was compacted by the second worker')
  hubB.stopWorker()
}

/**
 * Two workers compacting the same document is expected and must be harmless. The dangerous
 * interleaving is a worker that passes its pre-check, stalls, and only then merges: it now reads
 * the row the other worker persisted meanwhile, so its own `store` is skipped by
 * `ON CONFLICT DO NOTHING` while its `references` - and therefore `deleteReferences` - cover that
 * row. Without the post-merge re-check that deletes the only persisted copy of the document.
 *
 * @param {t.TestCase} tc
 */
export const testConcurrentCompactionKeepsTheDocument = async tc => {
  const prefix = 'yhub:testing:race'
  await clearPrefix(prefix)
  const hubA = await createWorkerHub({ taskDebounce: 1000 }, prefix)
  const hubB = await createWorkerHub({ taskDebounce: 1000 }, prefix)
  hubA.stopWorker()
  hubB.stopWorker()
  const docRef = { org: utils.defaultOrg, docid: tc.testName + '-index', branch: 'main' }
  await seedDocRef(hubA, docRef, 'important content')
  const entry = (await utils.yhub.stream.redis.xRange(hubA.stream.workerStreamName, '-', '+'))
    .find(e => e.message.compact === stream.encodeRoomName(docRef, prefix))
  const task = /** @type {any} */ ({ type: 'compact', docRef, redisClock: /** @type {any} */ (entry).id })

  // B passes its pre-check and then stalls right before the merge
  let entered = false
  /**
   * @type {() => void}
   */
  let release = () => {}
  const barrier = promise.create(resolve => { release = () => resolve(undefined) })
  const getDoc = hubB.getDoc.bind(hubB)
  hubB.getDoc = async (r, include, opts) => { entered = true; await barrier; return getDoc(r, include, opts) }

  const bDone = hubB._runTask(task)
  await promise.untilAsync(() => entered, 10000, 10)
  // A compacts and persists the whole document while B is stalled
  await hubA._runTask(task)
  release()
  await bDone

  const { gcDoc } = await hubA.persistence.retrieveDoc(docRef, { gc: true })
  t.assert(gcDoc.length > 0, 'the document is still persisted after both workers finished')
  const restored = new Y.Doc()
  gcDoc.forEach(update => Y.applyUpdate(restored, update))
  t.compare(restored.get('text').toString(), 'important content', 'the document survived the concurrent compaction')
}

/**
 * A compact entry whose key doesn't decode must not take the batch it was claimed in down with
 * it: `xAutoClaim` already took ownership of every entry in that batch, so throwing out of
 * `claimTasks` drops the legitimate tasks next to it and leaves the offender pending to poison
 * the next round just the same. It is dropped from the queue instead.
 *
 * An entry of an unknown *type* is the opposite case and is deliberately kept: it never throws,
 * so it wedges nothing, and it is exactly what a task type added by a newer release looks like
 * during a rolling upgrade. Deleting it would silently discard that release's work.
 *
 * @param {t.TestCase} tc
 */
export const testUndecodableTaskDoesNotWedgeTheWorker = async tc => {
  const prefix = 'yhub:testing:poison'
  const taskDebounce = 1000
  await clearPrefix(prefix)
  /**
   * @type {Array<string>}
   */
  const completed = []
  const hub = await createWorkerHub({ taskDebounce, taskComplete: ({ docRef }) => completed.push(docRef.docid) }, prefix)
  const redis = utils.yhub.stream.redis
  // park an undecodable compact entry and an entry of a type we don't know. XADD alone only
  // appends - the XREADGROUP is what puts them in the pending list, which is the only thing
  // claimTasks (XAUTOCLAIM) looks at. This is what the addMessage lua does for a real task.
  await redis.xAdd(hub.stream.workerStreamName, '*', { compact: `${prefix}:room:garbage` })
  await redis.xAdd(hub.stream.workerStreamName, '*', { nonsense: '1' })
  await redis.xReadGroup(hub.stream.workerGroupName, 'pending', { key: hub.stream.workerStreamName, id: '>' }, { COUNT: 2 })

  const docRef = { org: utils.defaultOrg, docid: tc.testName + '-index', branch: 'main' }
  await seedDocRef(hub, docRef, 'poisoned')
  // the bad entries idle out first, so they are claimed either alongside this document's task or
  // in the round right before it. Either way the document has to be compacted without delay -
  // before the fix the worker never got past them and this deadline is never met.
  await promise.untilAsync(() => completed.includes(docRef.docid), taskDebounce * 3, 50)
  // the undecodable compact entry is dropped, the unknown type stays for a worker that knows it.
  // `waitDrained` is no use here - its XLEN of the worker stream never reaches 0 by design.
  await promise.untilAsync(async () => {
    const entries = await redis.xRange(hub.stream.workerStreamName, '-', '+')
    return entries.length === 1 && entries[0].message.nonsense === '1'
  }, 10000, 50)
  const pending = await redis.xPendingRange(hub.stream.workerStreamName, hub.stream.workerGroupName, '-', '+', 10)
  t.compare(pending.length, 1, 'the unknown task type is still pending for another worker to claim')

  const { gcDoc } = await hub.persistence.retrieveDoc(docRef, { gc: true })
  const restored = new Y.Doc()
  gcDoc.forEach(update => Y.applyUpdate(restored, update))
  t.compare(restored.get('text').toString(), 'poisoned', 'the document next to the bad entries was compacted')
  // the surviving entry is re-claimed and re-logged every round for as long as this worker runs
  hub.stopWorker()
}
