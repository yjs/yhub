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
  const merged = await pool.mergeUpdatesAndGc([update1, update2])
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
  const merged = await pool.mergeUpdates([update1, update2])
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
    const mergeResult = await pool.mergeUpdates([invalidUpdate, invalidUpdate])
    console.log({ mergeResult })
  } catch (_err) {
    failed = true
  }
  t.assert(failed, 'mergeUpdates with invalid update should throw')
  // pool should still work after a failed task
  const doc = new Y.Doc()
  doc.get('test').insert(0, 'still works')
  const update = Y.encodeStateAsUpdate(doc)
  const merged = await pool.mergeUpdates([update])
  const resultDoc = new Y.Doc()
  Y.applyUpdate(resultDoc, merged)
  t.assert(resultDoc.get('test').toString() === 'still works', 'pool should recover after error')
  resultDoc.destroy()
  doc.destroy()
  await pool.destroy()
}
