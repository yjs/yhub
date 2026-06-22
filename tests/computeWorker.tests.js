import * as t from 'lib0/testing'
import * as Y from '@y/y'
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
