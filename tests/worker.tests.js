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
