import * as t from 'lib0/testing'
import * as Y from '@y/y'
import * as decoding from 'lib0/decoding'
import * as delta from 'lib0/delta'
import * as promise from 'lib0/promise'
import * as buffer from 'lib0/buffer'
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import { createComputePool, isComputeQueueFull } from '../src/compute.js'
import { createContentMap } from '../src/y-utils.js'
import * as utils from './utils.js'

const queueFullPort = utils.testHubPort(-2)

// no compute thread and no queue: every task this hub offloads is rejected as COMPUTE_QUEUE_FULL
await utils.createTestHub({
  computePool: { maxThreads: 0, maxQueue: 0 },
  server: { ...utils.yhub.conf.server, port: queueFullPort }
})

/**
 * @param {t.TestCase} _tc
 */
export const testMergeUpdatesAndGc = async _tc => {
  const pool = createComputePool({ maxThreads: 2 })
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
  const pool = createComputePool({ maxThreads: 2 })
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
  const pool = createComputePool({ maxThreads: 2 })
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
  const pool = createComputePool({ maxThreads: 2 })
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
    groupByUser: true,
    groupMaxGap: 1000,
    groupMaxDuration: Number.MAX_SAFE_INTEGER,
    groupExclude: [],
    // no `versions` - callers from before named versions keep working
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
  // an exempt user's own edits never merge; excluding someone else changes nothing
  t.assert((await activity({ groupExclude: ['user1'] })).length === 3)
  t.compare((await activity({ groupExclude: ['someoneelse'] })).map(a => [a.from, a.to]), [[1000, 2000]])
  doc.destroy()
  await pool.destroy()
}

/**
 * `groupByUser:false` lets consecutive changes merge across authors - the gap/duration bounds
 * alone decide - and reports every contributing author in `by` as an array.
 *
 * @param {t.TestCase} _tc
 */
export const testActivityGroupByUser = async _tc => {
  const pool = createComputePool({ maxThreads: 2 })
  const doc = new Y.Doc({ gc: false })
  // three interleaved edits: user1@1000, user2@1500, user1@2000
  doc.get('test').insert(0, 'hello')
  const contentIds1 = Y.createContentIdsFromUpdate(Y.encodeStateAsUpdate(doc))
  const contentmap1 = Y.createContentMapFromContentIds(
    contentIds1,
    [Y.createContentAttribute('insert', 'user1'), Y.createContentAttribute('insertAt', 1000), Y.createContentAttribute('insert:source', 'import')],
    [Y.createContentAttribute('delete', 'user1'), Y.createContentAttribute('deleteAt', 1000)]
  )
  doc.get('test').insert(5, ' world')
  const contentIds2 = Y.createContentIdsFromUpdate(Y.encodeStateAsUpdate(doc))
  const contentmap2 = Y.createContentMapFromContentIds(
    Y.excludeContentIds(contentIds2, contentIds1),
    [Y.createContentAttribute('insert', 'user2'), Y.createContentAttribute('insertAt', 1500), Y.createContentAttribute('insert:source', 'import')],
    [Y.createContentAttribute('delete', 'user2'), Y.createContentAttribute('deleteAt', 1500)]
  )
  doc.get('test').insert(11, '!')
  const nongcDoc = Y.encodeStateAsUpdate(doc)
  const contentmap3 = Y.createContentMapFromContentIds(
    Y.excludeContentIds(Y.createContentIdsFromUpdate(nongcDoc), contentIds2),
    [Y.createContentAttribute('insert', 'user1'), Y.createContentAttribute('insertAt', 2000), Y.createContentAttribute('insert:source', 'import')],
    [Y.createContentAttribute('delete', 'user1'), Y.createContentAttribute('deleteAt', 2000)]
  )
  const contentmapBin = Y.encodeContentMap(Y.mergeContentMaps([contentmap1, contentmap2, contentmap3]))
  /**
   * @param {object} opts
   * @return {Promise<Array<{ from: number, to: number, by: string|null|Array<string?>, customAttributions: Array<{k:string,v:string}>|null }>>}
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
    groupByUser: true,
    groupMaxGap: 1000,
    groupMaxDuration: Number.MAX_SAFE_INTEGER,
    groupExclude: [],
    versions: [],
    ...opts
  }))).activity
  // grouping by user: the author changes on every edit, so nothing merges and `by` stays scalar
  t.compare((await activity({})).map(a => [a.from, a.to, a.by]), [[1000, 1000, 'user1'], [1500, 1500, 'user2'], [2000, 2000, 'user1']])
  // ignoring the author: the gaps alone decide, and `by` lists both authors without repeating user1
  t.compare((await activity({ groupByUser: false })).map(a => [a.from, a.to, a.by]), [[1000, 2000, ['user1', 'user2']]])
  // `by` is an array even when a single author contributed the whole entry
  t.compare((await activity({ groupByUser: false, by: 'user1' })).map(a => a.by), [['user1'], ['user1']])
  // the gap and duration bounds still apply
  t.compare((await activity({ groupByUser: false, groupMaxGap: 400 })).map(a => [a.from, a.to, a.by]), [[1000, 1000, ['user1']], [1500, 1500, ['user2']], [2000, 2000, ['user1']]])
  t.compare((await activity({ groupByUser: false, groupMaxGap: 10000, groupMaxDuration: 600 })).map(a => [a.from, a.to, a.by]), [[1000, 1500, ['user1', 'user2']], [2000, 2000, ['user1']]])
  // an exempt user never merges in either direction, so nothing groups across their edit
  t.compare((await activity({ groupByUser: false, groupExclude: ['user2'] })).map(a => [a.from, a.to, a.by]), [[1000, 1000, ['user1']], [1500, 1500, ['user2']], [2000, 2000, ['user1']]])
  // custom attributions of a cross-author group are still combined and deduplicated
  t.compare((await activity({ groupByUser: false, includeCustomAttributions: true })).map(a => a.customAttributions), [[{ k: 'source', v: 'import' }]])
  doc.destroy()
  await pool.destroy()
}

/**
 * Named versions cut the activity: no entry spans a version, the entry holding the last change up
 * to (and including) the time of a version ends at it and carries it, and a version without a
 * change since the previous cut is an entry of its own. Filters never hide a version.
 *
 * @param {t.TestCase} _tc
 */
export const testActivityNamedVersions = async _tc => {
  const pool = createComputePool({ maxThreads: 2 })
  const doc = new Y.Doc({ gc: false })
  // three interleaved edits: user1@1000 'hello', user2@1500 ' world', user1@2000 '!'
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
    [Y.createContentAttribute('insert', 'user2'), Y.createContentAttribute('insertAt', 1500)],
    [Y.createContentAttribute('delete', 'user2'), Y.createContentAttribute('deleteAt', 1500)]
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
   * @param {number} t
   * @param {string} name
   */
  const v = (t, name) => /** @type {import('../src/types.js').Version} */ ({ type: 'version:v1', t, name, createdAt: 1, updatedAt: 1, createdBy: 'user1', updatedBy: 'user1', custom: { tags: [name] }, published: false, publishedAt: null, publishedBy: null })
  /**
   * @param {object} opts
   * @return {Promise<Array<{ from: number, to: number, by: string|null|Array<string?>, customAttributions: Array<{k:string,v:string}>|null, version?: any, isEmpty?: boolean, delta?: any, attributions?: Uint8Array<ArrayBuffer> }>>}
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
    groupByUser: false,
    groupMaxGap: 1000,
    groupMaxDuration: Number.MAX_SAFE_INTEGER,
    groupExclude: [],
    versions: [],
    ...opts
  }))).activity
  /**
   * @param {Awaited<ReturnType<typeof activity>>} entries
   */
  const summary = entries => entries.map(a => [a.from, a.to, a.by, a.version?.name ?? null])
  // without versions everything merges into one entry
  t.compare(summary(await activity({})), [[1000, 2000, ['user1', 'user2'], null]])
  // a version between two changes closes the entry at its time
  t.compare(summary(await activity({ versions: [v(1200, 'a')] })), [[1000, 1200, ['user1'], 'a'], [1500, 2000, ['user2', 'user1'], null]])
  // a change at exactly the time of a version belongs to it
  t.compare(summary(await activity({ versions: [v(1500, 'a')] })), [[1000, 1500, ['user1', 'user2'], 'a'], [2000, 2000, ['user1'], null]])
  // a version before the first change, and consecutive versions, are entries of their own
  t.compare(summary(await activity({ versions: [v(500, 'a')] })), [[500, 500, [], 'a'], [1000, 2000, ['user1', 'user2'], null]])
  t.compare(summary(await activity({ versions: [v(1200, 'a'), v(1300, 'b')] })), [[1000, 1200, ['user1'], 'a'], [1300, 1300, [], 'b'], [1500, 2000, ['user2', 'user1'], null]])
  // an entry of a version alone is flagged, every other entry isn't
  t.compare((await activity({ versions: [v(500, 'a')] })).map(a => a.isEmpty), [true, undefined])
  t.compare((await activity({ versions: [v(1200, 'a'), v(1300, 'b')] })).map(a => a.isEmpty), [undefined, true, undefined])
  // a version attaches to the previous entry however far past groupMaxGap it lies
  const far = await activity({ groupMaxGap: 1000, versions: [v(100000, 'a')] })
  t.compare(summary(far), [[1000, 100000, ['user1', 'user2'], 'a']])
  t.assert(far[0].isEmpty === undefined)
  // trailing versions: the first extends the open entry, the rest stand alone
  t.compare(summary(await activity({ versions: [v(3000, 'a'), v(4000, 'b')] })), [[1000, 3000, ['user1', 'user2'], 'a'], [4000, 4000, [], 'b']])
  // the version object is delivered as stored
  t.compare((await activity({ versions: [v(3000, 'a')] }))[0].version, v(3000, 'a'))
  // stored rows are not re-validated on read - a row written by a newer release passes through
  const future = /** @type {any} */ ({ type: 'version:v2', t: 3000, label: 'b' })
  t.compare((await activity({ versions: [future] }))[0].version, future)
  // filters never hide a version - with nothing matching before it, it stands alone
  t.compare(summary(await activity({ groupByUser: true, by: 'user2', versions: [v(1200, 'a')] })), [[1200, 1200, null, 'a'], [1500, 1500, 'user2', null]])
  t.compare(summary(await activity({ groupByUser: true, by: 'user2', versions: [v(1700, 'a')] })), [[1500, 1700, 'user2', 'a']])
  // an empty entry carries empty custom attributions when they are asked for
  t.compare((await activity({ includeCustomAttributions: true, versions: [v(500, 'a')] })).map(a => a.customAttributions), [[], []])
  t.compare((await activity({ versions: [v(500, 'a')] })).map(a => a.customAttributions), [null, null])
  // the duration bound still applies to the changes; only the reported `to` extends
  t.compare(summary(await activity({ groupMaxGap: 10000, groupMaxDuration: 600, versions: [v(3000, 'a')] })), [[1000, 1500, ['user1', 'user2'], null], [2000, 3000, ['user1'], 'a']])
  // order and limit count version entries
  t.compare(summary(await activity({ reverse: true, limit: 1, versions: [v(3000, 'a'), v(4000, 'b')] })), [[4000, 4000, [], 'b']])
  // rendered: a cut entry is the document at the version's time with its own changes attributed,
  // an empty entry is the document at its time with nothing attributed
  const rendered = await activity({ includeDelta: true, includeAttributions: true, versions: [v(500, 'a'), v(1200, 'b')] })
  /**
   * @param {any} d
   */
  const text = d => (d.children ?? []).map((/** @type {any} */ c) => c.insert ?? '').join('')
  t.compare(rendered.map(a => text(a.delta)), ['', 'hello', 'hello world!'])
  const attributed = rendered.map(a => Y.createContentIdsFromContentMap(Y.decodeContentMap(/** @type {Uint8Array<ArrayBuffer>} */ (a.attributions))).inserts)
  t.assert(attributed[0].isEmpty())
  t.assert(Y.diffIdSet(attributed[1], contentIds1.inserts).isEmpty() && Y.diffIdSet(contentIds1.inserts, attributed[1]).isEmpty())
  doc.destroy()
  await pool.destroy()
}

/**
 * @param {t.TestCase} _tc
 */
export const testInvalidUpdate = async _tc => {
  const pool = createComputePool({ maxThreads: 2 })
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
  const pool = createComputePool({ maxThreads: 2 })
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
  const pool = createComputePool({ maxThreads: 1, taskTimeout: 1 })
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

/**
 * The queue is bounded: with one thread and `maxQueue: 1`, the first task runs, the second waits
 * and the third is rejected right away. The admitted tasks are unaffected.
 *
 * @param {t.TestCase} _tc
 */
export const testComputeQueueLimit = async _tc => {
  const doc = new Y.Doc()
  doc.get('test').insert(0, 'a'.repeat(10000))
  const update = Y.encodeStateAsUpdate(doc)
  const pool = createComputePool({ maxThreads: 1, maxQueue: 1 })
  const first = pool.mergeUpdates(true, [update, update])
  const second = pool.mergeUpdates(true, [update, update])
  t.compare(pool.stats(), { queued: 1, busy: 1, workers: 1 })
  const err = await pool.mergeUpdates(true, [update, update]).then(() => null, err => err)
  t.assert(isComputeQueueFull(err), 'the third task is rejected with COMPUTE_QUEUE_FULL')
  t.compare(pool.stats(), { queued: 1, busy: 1, workers: 1 }, 'the rejected task was never queued')
  for (const merged of await promise.all([first, second])) {
    const resultDoc = new Y.Doc()
    Y.applyUpdate(resultDoc, merged)
    t.assert(resultDoc.get('test').toString().length === 10000)
    resultDoc.destroy()
  }
  t.compare(pool.stats(), { queued: 0, busy: 0, workers: 1 })
  doc.destroy()
  await pool.destroy()
}

/**
 * A full compute queue is overload, not a failure: rest requests answer 503 and a websocket's
 * initial sync closes with 1013 - both transient, so clients retry.
 *
 * @param {t.TestCase} tc
 */
export const testComputeQueueFullIsTransient = async tc => {
  const { yhub, org, defaultDocRef } = await utils.createTestCase(tc)
  // two updates of more than 5120 bytes in all - reading the document merges them in a thread
  const doc = new Y.Doc()
  doc.get('test').insert(0, 'a'.repeat(6000))
  const update1 = Y.encodeStateAsUpdate(doc)
  const sv = Y.encodeStateVector(doc)
  doc.get('test').insert(0, 'b')
  const update2 = Y.encodeStateAsUpdate(doc, sv)
  for (const update of [update1, update2]) {
    await yhub.stream.addMessage(defaultDocRef, { type: 'ydoc:update:v1', update, contentmap: createContentMap(Y.createContentIdsFromUpdate(update), 'user1', []) })
  }
  for (const endpoint of ['ydoc', 'changeset', 'activity']) {
    const res = await fetch(`http://localhost:${queueFullPort}/api/${endpoint}/v1/${org}/${defaultDocRef.docid}`)
    t.assert(res.status === 503, `${endpoint} must 503`)
    t.compare(buffer.decodeAny(new Uint8Array(await res.arrayBuffer())), { error: 'compute queue full', code: 'compute-queue-full' })
  }
  const ws = new WebSocket(`${utils.wsUrlFromPort(queueFullPort)}/${defaultDocRef.docid}`)
  const closed = await promise.create(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  t.compare(closed, { code: 1013, reason: 'compute queue full' })
  doc.destroy()
}

/**
 * `taskTimeout` also bounds the wait for a thread: a task still queued when it elapses is
 * rejected, instead of waiting behind tasks that may each run that long.
 *
 * @param {t.TestCase} _tc
 */
export const testQueuedTaskTimeout = async _tc => {
  const doc = new Y.Doc()
  doc.get('test').insert(0, 'a'.repeat(10000))
  const update = Y.encodeStateAsUpdate(doc)
  const pool = createComputePool({ maxThreads: 1, taskTimeout: 1 })
  const [running, queued] = await Promise.allSettled([pool.mergeUpdates(true, [update, update]), pool.mergeUpdates(true, [update, update])])
  t.assert(running.status === 'rejected' && running.reason.message === 'Worker terminated', 'the running task was killed')
  t.assert(queued.status === 'rejected' && queued.reason.message === 'compute task exceeded taskTimeout while queued', 'the queued task timed out waiting')
  t.compare(pool.stats().queued, 0)
  doc.destroy()
  await pool.destroy()
}

/**
 * `resourceLimits` cap each thread's heap. A merge that exceeds them kills only its thread - the
 * 'error'/'exit' path rejects the task and the pool replaces the thread - long before the threads
 * together could outgrow the memory of the process. In child processes: V8 applies `--max-old-space-size`,
 * which the test runner sets, to every thread, overriding `maxOldGenerationSizeMb` - the second
 * run checks that the pool warns about it.
 *
 * @param {t.TestCase} _tc
 */
export const testWorkerResourceLimits = async _tc => {
  /**
   * @param {Array<string>} execArgv
   * @return {Promise<{ exitCode: number|null, logs: Array<{ msg: string }>, result: { code: string|null, stats: any, recovered: boolean } }>}
   */
  const run = async execArgv => {
    const child = spawn(process.execPath, [...execArgv, '--input-type=module', '-e', `
      import * as Y from '@y/y'
      import { createComputePool } from '${new URL('../src/compute.js', import.meta.url)}'
      // inserting at the front never extends the previous item, so the document has n items -
      // each an object on the worker's heap during a gc merge
      const build = n => {
        const doc = new Y.Doc()
        doc.transact(() => {
          for (let i = 0; i < n; i++) doc.get('test').insert(0, 'x')
        })
        return Y.encodeStateAsUpdate(doc)
      }
      const small = build(1000)
      const large = build(100000)
      const pool = createComputePool({ maxThreads: 1, resourceLimits: { maxOldGenerationSizeMb: 16 } })
      await pool.mergeUpdates(true, [small, small])
      const err = await pool.mergeUpdates(true, [large, large]).then(() => null, err => err)
      const stats = pool.stats()
      const doc = new Y.Doc()
      Y.applyUpdate(doc, await pool.mergeUpdates(true, [small, small]))
      process.stdout.write(JSON.stringify({ code: err?.code ?? null, stats, recovered: doc.get('test').toString().length === 1000 }) + '\\n')
      await pool.destroy()
    `], { env: { ...process.env, NODE_OPTIONS: '', LOG_LEVEL: 'warn' }, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', data => { out += data })
    const exitCode = await promise.create(resolve => child.once('close', resolve))
    // pino's log lines, then the result
    const lines = out.trim().split('\n').map(line => JSON.parse(line))
    return { exitCode, logs: lines.slice(0, -1), result: lines[lines.length - 1] }
  }
  const limited = await run([])
  t.assert(limited.exitCode === 0, 'the process survived')
  t.assert(limited.result.code === 'ERR_WORKER_OUT_OF_MEMORY', 'the large merge exceeded the heap limit')
  t.compare(limited.result.stats, { queued: 0, busy: 0, workers: 0 }, 'only the thread died')
  t.assert(limited.result.recovered, 'the pool replaced the dead thread and keeps working')
  t.assert(limited.logs.every(log => !log.msg.includes('has no effect')), 'no warning without the flag')
  const flagged = await run(['--max-old-space-size=8192'])
  t.assert(flagged.exitCode === 0)
  t.assert(flagged.result.code === null, 'the flag overrode the limit of the thread')
  t.assert(flagged.logs.some(log => log.msg.includes('has no effect')), 'the pool warned at startup')
}

/**
 * A whole-document update from a gc'd client (the GET -> edit -> PATCH body) carries a
 * ContentDeleted stub for every deleted id the nongc history holds with content. Merged after the
 * persisted history - the order getDoc uses - the stub must not replace the content, otherwise
 * rollback has nothing to restore. Pins @y/y >= 14.0.0-rc.28, whose mergeUpdates keeps the
 * encoding it saw first; before, a clock tie went to the later update.
 *
 * @param {t.TestCase} _tc
 */
export const testMergeUpdatesKeepsDeletedContent = async _tc => {
  const pool = createComputePool({ maxThreads: 2 })
  /**
   * @param {string} padding long enough to leave the inline path (> 5120 bytes)
   */
  const check = async padding => {
    const server = new Y.Doc({ gc: false })
    server.get().applyDelta(delta.create().insert(padding + 'abc').done())
    server.get().applyDelta(delta.create().retain(padding.length + 1).delete(1).done()) // 'b' deleted, content retained
    const nongcDoc = Y.encodeStateAsUpdate(server)
    const gcClient = new Y.Doc() // gc: 'b' becomes a ContentDeleted stub on apply
    Y.applyUpdate(gcClient, nongcDoc)
    gcClient.get().applyDelta(delta.create().insert('d').done())
    const patch = Y.encodeStateAsUpdate(gcClient)
    const merged = await pool.mergeUpdates(false, [nongcDoc, patch])
    const doc = new Y.Doc({ gc: false })
    Y.applyUpdate(doc, merged)
    t.compare(doc.get().toDelta(), delta.create(delta.$deltaAny).insert('d' + padding + 'ac'))
    // what the rollback task does: undo the deletion from the nongc doc
    Y.undoContentIds(doc, Y.createContentIds(Y.createIdSet(), Y.createContentIdsFromUpdate(merged).deletes), { ignoreRemoteAttributeChanges: true })
    t.compare(doc.get().toDelta(), delta.create(delta.$deltaAny).insert('d' + padding + 'abc'), 'deleted content survives a gc\'d whole-document update')
    doc.destroy()
    server.destroy()
    gcClient.destroy()
  }
  await check('') // inline (<= 5120 bytes)
  await check('x'.repeat(6000)) // worker thread
  await pool.destroy()
}
