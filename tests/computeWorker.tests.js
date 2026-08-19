import * as t from 'lib0/testing'
import * as Y from '@y/y'
import * as decoding from 'lib0/decoding'
import { createComputePool } from '../src/compute.js'

/**
 * @param {t.TestCase} _tc
 */
export const testMergeUpdatesAndGc = async _tc => {
  const pool = createComputePool({ poolSize: 2 })
  const doc1 = new Y.Doc()
  doc1.get('test').insert(0, 'hello')
  const update1 = Y.encodeStateAsUpdate(doc1)
  const doc2 = new Y.Doc()
  Y.applyUpdate(doc2, update1)
  doc2.get('test').insert(5, ' world')
  const update2 = Y.encodeStateAsUpdate(doc2)
  const merged = await pool.mergeUpdates(true, [update1, update2])
  const resultDoc = new Y.Doc()
  Y.applyUpdate(resultDoc, merged)
  t.assert(resultDoc.get('test').toString() === 'hello world')
  resultDoc.destroy()
  doc1.destroy()
  doc2.destroy()
  await pool.destroy()
}

/**
 * @param {t.TestCase} _tc
 */
export const testMergeUpdates = async _tc => {
  const pool = createComputePool({ poolSize: 2 })
  const doc1 = new Y.Doc()
  doc1.get('test').insert(0, 'hello')
  const update1 = Y.encodeStateAsUpdate(doc1)
  const doc2 = new Y.Doc()
  Y.applyUpdate(doc2, update1)
  doc2.get('test').insert(5, ' world')
  const update2 = Y.encodeStateAsUpdate(doc2)
  const merged = await pool.mergeUpdates(false, [update1, update2])
  const resultDoc = new Y.Doc()
  Y.applyUpdate(resultDoc, merged)
  t.assert(resultDoc.get('test').toString() === 'hello world')
  resultDoc.destroy()
  doc1.destroy()
  doc2.destroy()
  await pool.destroy()
}

/**
 * @param {t.TestCase} _tc
 */
export const testRollback = async _tc => {
  const pool = createComputePool({ poolSize: 2 })
  const doc = new Y.Doc({ gc: false })
  doc.get('test').insert(0, 'hello')
  const update1 = Y.encodeStateAsUpdate(doc)
  const contentIds1 = Y.createContentIdsFromUpdate(update1)
  const contentmap1 = Y.createContentMapFromContentIds(
    contentIds1,
    [Y.createContentAttribute('insert', 'user1'), Y.createContentAttribute('insertAt', 1000)],
    [Y.createContentAttribute('delete', 'user1'), Y.createContentAttribute('deleteAt', 1000)]
  )
  doc.get('test').insert(5, ' world')
  const nongcDoc = Y.encodeStateAsUpdate(doc)
  const update2 = Y.encodeStateAsUpdate(doc)
  const contentIds2 = Y.excludeContentIds(Y.createContentIdsFromUpdate(update2), contentIds1)
  const contentmap2 = Y.createContentMapFromContentIds(
    contentIds2,
    [Y.createContentAttribute('insert', 'user2'), Y.createContentAttribute('insertAt', 2000)],
    [Y.createContentAttribute('delete', 'user2'), Y.createContentAttribute('deleteAt', 2000)]
  )
  const contentmapBin = Y.encodeContentMap(Y.mergeContentMaps([contentmap1, contentmap2]))
  const result = await pool.rollback({
    nongcDoc,
    contentmapBin,
    by: 'user2',
    userid: 'admin',
    customAttributions: []
  })
  t.assert(result.update != null, 'rollback should produce an update')
  t.assert(result.contentmap != null, 'rollback should produce a contentmap')
  const verifyDoc = new Y.Doc()
  Y.applyUpdate(verifyDoc, nongcDoc)
  Y.applyUpdate(verifyDoc, result.update)
  console.log('verifyDoc', { s: verifyDoc.get('test').toDelta().toJSON(), nongcDoc, result })
  t.assert(verifyDoc.get('test').toString() === 'hello', 'rollback should revert user2 changes')
  verifyDoc.destroy()
  doc.destroy()
  await pool.destroy()
}

/**
 * @param {t.TestCase} _tc
 */
export const testActivityGrouping = async _tc => {
  const pool = createComputePool({ poolSize: 2 })
  const doc = new Y.Doc({ gc: false })
  // three edits by the same user at timestamps 1000, 1500, 2000
  doc.get('test').insert(0, 'hello')
  const contentIds1 = Y.createContentIdsFromUpdate(Y.encodeStateAsUpdate(doc))
  const contentmap1 = Y.createContentMapFromContentIds(
    contentIds1,
    [Y.createContentAttribute('insert', 'user1'), Y.createContentAttribute('insertAt', 1000)],
    [Y.createContentAttribute('delete', 'user1'), Y.createContentAttribute('deleteAt', 1000)]
  )
  doc.get('test').insert(5, ' world')
  const contentIds2 = Y.createContentIdsFromUpdate(Y.encodeStateAsUpdate(doc))
  const contentmap2 = Y.createContentMapFromContentIds(
    Y.excludeContentIds(contentIds2, contentIds1),
    [Y.createContentAttribute('insert', 'user1'), Y.createContentAttribute('insertAt', 1500)],
    [Y.createContentAttribute('delete', 'user1'), Y.createContentAttribute('deleteAt', 1500)]
  )
  doc.get('test').insert(11, '!')
  const nongcDoc = Y.encodeStateAsUpdate(doc)
  const contentmap3 = Y.createContentMapFromContentIds(
    Y.excludeContentIds(Y.createContentIdsFromUpdate(nongcDoc), contentIds2),
    [Y.createContentAttribute('insert', 'user1'), Y.createContentAttribute('insertAt', 2000)],
    [Y.createContentAttribute('delete', 'user1'), Y.createContentAttribute('deleteAt', 2000)]
  )
  const contentmapBin = Y.encodeContentMap(Y.mergeContentMaps([contentmap1, contentmap2, contentmap3]))
  /**
   * @param {object} opts
   * @return {Promise<Array<{ from: number, to: number, by: string? }>>}
   */
  const activity = async (opts = {}) => decoding.readAny(decoding.createDecoder(await pool.activity({
    nongcDoc,
    contentmapBin,
    from: 0,
    to: Number.MAX_SAFE_INTEGER,
    by: '',
    withCustomAttributions: null,
    includeCustomAttributions: false,
    includeDelta: false,
    includeYdoc: false,
    includeAttributions: false,
    limit: Number.MAX_SAFE_INTEGER,
    reverse: false,
    group: true,
    groupMaxGap: 1000,
    groupMaxDuration: Number.MAX_SAFE_INTEGER,
    mergeUsers: false,
    ...opts
  }))).activity
  // default: 500ms gaps are below groupMaxGap=1000, everything merges
  const grouped = await activity({})
  t.compare(grouped.map(a => [a.from, a.to]), [[1000, 2000]])
  // gaps exceed groupMaxGap=400, nothing merges
  const smallGap = await activity({ groupMaxGap: 400 })
  t.compare(smallGap.map(a => [a.from, a.to]), [[1000, 1000], [1500, 1500], [2000, 2000]])
  // merging the third edit would span 1000ms >= groupMaxDuration=600, so it starts a new group
  const capped = await activity({ groupMaxGap: 10000, groupMaxDuration: 600 })
  t.compare(capped.map(a => [a.from, a.to]), [[1000, 1500], [2000, 2000]])
  const ungrouped = await activity({ group: false })
  t.assert(ungrouped.length === 3)
  doc.destroy()
  await pool.destroy()
}

/**
 * @param {t.TestCase} _tc
 */
export const testActivityMergeUsers = async _tc => {
  const pool = createComputePool({ poolSize: 2 })
  const doc = new Y.Doc({ gc: false })
  // three edits at timestamps 1000, 1500, 2000, authored user1 -> user2 -> user1
  /** @type {Array<Y.ContentMap>} */
  const contentmaps = []
  let prevContentIds = Y.createContentIdsFromUpdate(Y.encodeStateAsUpdate(new Y.Doc()))
  /**
   * @param {string} text
   * @param {string} user
   * @param {number} at
   */
  const edit = (text, user, at) => {
    doc.get('test').insert(doc.get('test').length, text)
    const contentIds = Y.createContentIdsFromUpdate(Y.encodeStateAsUpdate(doc))
    contentmaps.push(Y.createContentMapFromContentIds(
      Y.excludeContentIds(contentIds, prevContentIds),
      [Y.createContentAttribute('insert', user), Y.createContentAttribute('insertAt', at)],
      [Y.createContentAttribute('delete', user), Y.createContentAttribute('deleteAt', at)]
    ))
    prevContentIds = contentIds
  }
  edit('hello', 'user1', 1000)
  edit(' world', 'user2', 1500)
  edit('!', 'user1', 2000)
  const nongcDoc = Y.encodeStateAsUpdate(doc)
  const contentmapBin = Y.encodeContentMap(Y.mergeContentMaps(contentmaps))
  /**
   * @param {object} opts
   * @return {Promise<Array<{ from: number, to: number, by: string? }>>}
   */
  const activity = async (opts = {}) => decoding.readAny(decoding.createDecoder(await pool.activity({
    nongcDoc,
    contentmapBin,
    from: 0,
    to: Number.MAX_SAFE_INTEGER,
    by: '',
    withCustomAttributions: null,
    includeCustomAttributions: false,
    includeDelta: false,
    includeYdoc: false,
    includeAttributions: false,
    limit: Number.MAX_SAFE_INTEGER,
    reverse: false,
    group: true,
    groupMaxGap: 1000,
    groupMaxDuration: Number.MAX_SAFE_INTEGER,
    mergeUsers: false,
    ...opts
  }))).activity
  // without mergeUsers the author changes on every edit, so nothing groups
  const perUser = await activity({})
  t.compare(perUser.map(a => [a.from, a.to, a.by]), [[1000, 1000, 'user1'], [1500, 1500, 'user2'], [2000, 2000, 'user1']])
  // with mergeUsers the gaps alone decide: one entry listing both authors, user1 not repeated
  const merged = await activity({ mergeUsers: true })
  t.compare(merged.map(a => [a.from, a.to, a.by]), [[1000, 2000, 'user1,user2']])
  // mergeUsers still respects groupMaxGap
  const smallGap = await activity({ mergeUsers: true, groupMaxGap: 400 })
  t.compare(smallGap.map(a => [a.from, a.to, a.by]), [[1000, 1000, 'user1'], [1500, 1500, 'user2'], [2000, 2000, 'user1']])
  // ...and groupMaxDuration: the third edit would span 1000ms >= 600, so it starts a new group
  const capped = await activity({ mergeUsers: true, groupMaxGap: 10000, groupMaxDuration: 600 })
  t.compare(capped.map(a => [a.from, a.to, a.by]), [[1000, 1500, 'user1,user2'], [2000, 2000, 'user1']])
  doc.destroy()
  await pool.destroy()
}

/**
 * @param {t.TestCase} _tc
 */
export const testInvalidUpdate = async _tc => {
  const pool = createComputePool({ poolSize: 2 })
  let failed = false
  try {
    const invalidUpdate = new Uint8Array([])
    const mergeResult = await pool.mergeUpdates(false, [invalidUpdate, invalidUpdate])
    console.log({ mergeResult })
  } catch (_err) {
    failed = true
  }
  t.assert(failed, 'mergeUpdates with invalid update should throw')
  // pool should still work after a failed task
  const doc = new Y.Doc()
  doc.get('test').insert(0, 'still works')
  const update = Y.encodeStateAsUpdate(doc)
  const merged = await pool.mergeUpdates(false, [update])
  const resultDoc = new Y.Doc()
  Y.applyUpdate(resultDoc, merged)
  t.assert(resultDoc.get('test').toString() === 'still works', 'pool should recover after error')
  resultDoc.destroy()
  doc.destroy()
  await pool.destroy()
}

/**
 * @param {t.TestCase} _tc
 */
export const testComputePruneSet = async _tc => {
  const pool = createComputePool({ poolSize: 2 })
  const doc = new Y.Doc({ gc: false })
  const tp = doc.get('test')
  /** @type {Array<Y.ContentMap>} */
  const cms = []
  /** @param {() => void} fn */
  const cap = fn => { let u = /** @type {Uint8Array<ArrayBuffer>} */ (new Uint8Array()); doc.once('update', e => { u = e }); fn(); return u }
  /** @param {Uint8Array<ArrayBuffer>} u @param {number} ts */
  const stamp = (u, ts) => { cms.push(Y.createContentMapFromContentIds(Y.createContentIdsFromUpdate(u), [Y.createContentAttribute('insertAt', ts)], [Y.createContentAttribute('deleteAt', ts)])) }
  stamp(cap(() => tp.insert(0, 'AAA')), 1000) // churn: inserted t1
  stamp(cap(() => tp.insert(3, 'BBB')), 2000) // survivor: inserted t2, never deleted
  stamp(cap(() => tp.delete(0, 3)), 3000) // churn: 'AAA' deleted t3
  const nongcDoc = Y.encodeStateAsUpdate(doc)
  const contentmapBin = Y.encodeContentMap(Y.mergeContentMaps(cms))

  // content inserted AND deleted within [1000, 3000] -> 'AAA'
  const prune = await pool.computePruneSet({ contentmapBin, from: 1000, to: 3000 })
  t.assert(prune != null, 'should find churned content to prune')
  const pruned = await pool.mergeUpdates(false, [nongcDoc], {}, /** @type {Uint8Array<ArrayBuffer>} */ (prune))
  const verify = new Y.Doc({ gc: false })
  Y.applyUpdate(verify, pruned)
  t.assert(verify.get('test').toString() === 'BBB', 'survivor remains, churn pruned')
  verify.destroy()

  // nothing is fully contained in [2000, 2000] (BBB is never deleted) -> null
  const empty = await pool.computePruneSet({ contentmapBin, from: 2000, to: 2000 })
  t.assert(empty == null, 'no churn in range -> null prune set')

  // gcIdSet only collects deleted content: a prune set covering a live id is a no-op for it
  const liveDoc = new Y.Doc({ gc: false })
  liveDoc.get('test').insert(0, 'XY')
  const liveUpdate = Y.encodeStateAsUpdate(liveDoc)
  const livePrune = Y.encodeIdSet(Y.createContentIdsFromUpdate(liveUpdate).inserts)
  const mergedLive = await pool.mergeUpdates(false, [liveUpdate], {}, livePrune)
  const verifyLive = new Y.Doc({ gc: false })
  Y.applyUpdate(verifyLive, mergedLive)
  t.assert(verifyLive.get('test').toString() === 'XY', 'gcIdSet skips non-deleted ids')
  verifyLive.destroy()
  liveDoc.destroy()

  doc.destroy()
  await pool.destroy()
}

/**
 * A compute task can't be cancelled cooperatively, so a task that doesn't come back on its own is
 * stopped by killing its worker thread. The pool arms a timer per task, terminates the thread when
 * it fires, and rejects the task so the caller can retry. `taskTimeout: 1` makes every offloaded
 * task overrun - spawning the thread alone takes longer than a millisecond.
 *
 * @param {t.TestCase} _tc
 */
export const testTaskTimeoutKillsWorkerThread = async _tc => {
  const doc1 = new Y.Doc()
  doc1.get('test').insert(0, 'a'.repeat(10000))
  const update1 = Y.encodeStateAsUpdate(doc1)
  const doc2 = new Y.Doc()
  Y.applyUpdate(doc2, update1)
  doc2.get('test').insert(0, 'b'.repeat(10000))
  const update2 = Y.encodeStateAsUpdate(doc2)
  const pool = createComputePool({ poolSize: 1, taskTimeout: 1 })
  await t.failsAsync(() => pool.mergeUpdates(true, [update1, update2]))
  t.assert(pool.workers.every(w => w.isDead), 'the worker thread was terminated')
  // the pool replaces the dead thread and keeps working
  pool.taskTimeout = 60000
  const merged = await pool.mergeUpdates(true, [update1, update2])
  const resultDoc = new Y.Doc()
  Y.applyUpdate(resultDoc, merged)
  t.assert(resultDoc.get('test').toString().length === 20000, 'the pool recovered and merged the updates')
  resultDoc.destroy()
  doc1.destroy()
  doc2.destroy()
  await pool.destroy()
}
