import * as Y from '@y/y'
import * as t from 'lib0/testing'
import * as promise from 'lib0/promise'
import * as array from 'lib0/array'
import * as buffer from 'lib0/buffer'
import * as delta from 'lib0/delta'
import * as awarenessProtocol from '@y/protocols/awareness'
import * as types from '../src/types.js'
import * as stream from '../src/stream.js'
import { createContentMap } from '../src/y-utils.js'
import * as utils from './utils.js'

/**
 * The updated-documents listing (`GET /updated`): the redis index that shares its lifetime with a
 * document's stream, the persisted half, the cursor protocol, per-document authorization, and the
 * changeset's `t` and `diff` that a poller consumes.
 */

const { yhub, defaultOrg: org } = utils
const redis = yhub.stream.redis
const indexKey = stream.encodeDocUpdatedKey(org, yhub.stream.prefix)

/**
 * A hub whose auth plugin answers per document: docids ending in `-secret` are unreadable, `nobody`
 * holds no org grant, and `broken`'s document checks fail. Same redis and postgres as the shared
 * hub, so what is written there is listed here.
 */
const authPort = utils.testHubPort(12)
await utils.createTestHub({
  worker: null,
  server: {
    port: authPort,
    auth: types.createAuthPlugin({
      async authenticate (req) {
        const userid = req.getHeader('x-user') || null
        return userid === null ? null : { userid }
      },
      authorize: types.createAuthorize({
        org: async (_org, user) => user?.userid === 'nobody' ? null : { type: 'permissions:org:v1', endpoint: { updated: '-r--' } },
        document: async (docRef, user) => {
          if (user?.userid === 'broken') throw new Error('permission backend down')
          return docRef.docid.endsWith('-secret') ? null : { type: 'permissions:document:v1', ydoc: '-r--' }
        }
      })
    })
  }
})

/**
 * @typedef {{ docs: Array<{ docid: string, branch: string, t: number }>, next: number }} Listing
 */

/**
 * @param {string} path - below the api prefix
 * @param {object} [opts]
 * @param {string} [opts.host]
 * @param {string} [opts.user]
 * @param {boolean} [opts.json]
 * @return {Promise<{ status: number, body: any }>}
 */
const get = async (path, { host = utils.yhubHost, user, json = false } = {}) => {
  const res = await fetch(`http://${host}/api${path}`, { headers: { ...(user ? { 'x-user': user } : {}), ...(json ? { Accept: 'application/json' } : {}) } })
  return { status: res.status, body: json ? await res.json() : buffer.decodeAny(new Uint8Array(await res.arrayBuffer())) }
}

/**
 * A successful `GET /updated` page.
 *
 * @param {string} query - the query string of `/updated/v1/{org}`
 * @return {Promise<Listing>}
 */
const list = async query => {
  const res = await get(`/updated/v1/${org}?${query}`)
  t.assert(res.status === 200)
  return res.body
}

/**
 * A well-formed presence update - connected clients decode what the server fans out to them.
 */
const presence = () => {
  const awareness = new awarenessProtocol.Awareness(new Y.Doc())
  awareness.setLocalState({ user: 'tester' })
  return /** @type {Uint8Array<ArrayBuffer>} */ (awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]))
}

/**
 * Append one edit of `ydoc` to `docRef`'s stream, the way a socket does, and return the ms of its
 * stream clock.
 *
 * @param {import('../src/types.js').DocRef} docRef
 * @param {Y.Doc} ydoc
 * @param {() => void} edit
 */
const appendEdit = async (docRef, ydoc, edit) => {
  const sv = Y.encodeStateVector(ydoc)
  edit()
  const update = Y.encodeStateAsUpdate(ydoc, sv)
  const id = await yhub.stream.addMessage(docRef, { type: 'ydoc:update:v1', update, contentmap: createContentMap(Y.createContentIdsFromUpdate(update), 'user1', []) })
  return stream.redisClockToMs(id)
}

/**
 * The index entry is written by a content message (an update, a prune), never by awareness, at
 * that message's stream clock, and it leaves with the stream.
 *
 * @param {t.TestCase} tc
 */
export const testIndexFollowsTheStream = async tc => {
  const { defaultDocRef: docRef, defaultStream: liveKey } = await utils.createTestCase(tc)
  const member = stream.encodeDocUpdatedMember(docRef)
  await yhub.stream.addMessage(docRef, { type: 'awareness:v1', update: presence() })
  t.assert(await redis.zScore(indexKey, member) === null, 'awareness does not index the document')
  const ydoc = new Y.Doc()
  const t1 = await appendEdit(docRef, ydoc, () => ydoc.get().insert(0, 'hello'))
  t.assert(await redis.zScore(indexKey, member) === t1, 'an update indexes the document at its stream clock')
  await promise.wait(5)
  const t2 = await appendEdit(docRef, ydoc, () => ydoc.get().insert(5, ' world'))
  t.assert(t2 > t1 && await redis.zScore(indexKey, member) === t2, 'the score follows the last update')
  t.compare(await yhub.stream.getUpdatedDocs(org, { from: t1, to: t2 }), [{ docid: docRef.docid, branch: docRef.branch, t: t2 }])
  await promise.wait(5)
  const t3 = stream.redisClockToMs(await yhub.stream.addMessage(docRef, { type: 'prune:v1', prune: Y.encodeIdSet(Y.createIdSet()) }))
  t.assert(t3 > t2 && await redis.zScore(indexKey, member) === t3, 'a prune changes the document too')
  // the trim script's own path: an emptied stream takes its index entry with it. The script measures
  // age in whole seconds, so the last entry has to be in an earlier second than the trim.
  const taskid = (await redis.xRange(yhub.stream.workerStreamName, '-', '+')).find(e => e.message.compact === liveKey)?.id
  t.assert(taskid != null)
  await promise.wait(1000 - (t3 % 1000) + 20)
  await yhub.stream.trimMessages(docRef, array.last(await redis.xRange(liveKey, '-', '+')).id, 0, /** @type {string} */ (taskid))
  t.assert(await redis.exists(liveKey) === 0, 'the stream is gone')
  t.assert(await redis.zScore(indexKey, member) === null, 'and so is the index entry')
}

/**
 * A client that kept a local copy answers sync step 1 with its whole delete set, on every
 * connect: no struct the server lacks, only deletes it already holds. The socket queues it like
 * any update, but compaction must not persist it - that would move the document's clock and fire
 * `docUpdate` for an edit nobody made.
 *
 * @param {t.TestCase} tc
 */
export const testRedundantDeleteSetIsNotAnEdit = async tc => {
  const { defaultDocRef: docRef } = await utils.createTestCase(tc)
  const ydoc = new Y.Doc()
  await appendEdit(docRef, ydoc, () => ydoc.get().insert(0, 'hello world'))
  await appendEdit(docRef, ydoc, () => ydoc.get().delete(5, 6))
  await utils.waitTasksProcessed(yhub)
  const persisted = (await yhub.persistence.retrieveDoc(docRef, {})).lastClock
  const deleteSet = Y.encodeStateAsUpdate(ydoc, Y.encodeStateVector(ydoc))
  t.assert(deleteSet.byteLength > 3, 'big enough for the socket to queue it')
  await yhub.stream.addMessage(docRef, { type: 'ydoc:update:v1', update: deleteSet, contentmap: createContentMap(Y.createContentIdsFromUpdate(deleteSet), 'user1', []) })
  await utils.waitTasksProcessed(yhub)
  t.assert((await yhub.persistence.retrieveDoc(docRef, {})).lastClock === persisted, 'the persisted clock did not move')
  const edited = await appendEdit(docRef, ydoc, () => ydoc.get().insert(5, '!'))
  await utils.waitTasksProcessed(yhub)
  t.assert(stream.redisClockToMs((await yhub.persistence.retrieveDoc(docRef, {})).lastClock) === edited, 'a real edit still persists')
}

/**
 * `unquarantine` appends through the same script (in a MULTI) and must keep indexing.
 *
 * @param {t.TestCase} tc
 */
export const testUnquarantineKeepsIndexing = async tc => {
  const { defaultDocRef: docRef } = await utils.createTestCase(tc)
  const member = stream.encodeDocUpdatedMember(docRef)
  const ydoc = new Y.Doc()
  const t1 = await appendEdit(docRef, ydoc, () => ydoc.get().insert(0, 'hello'))
  const qid = await yhub.stream.quarantine(docRef)
  t.assert(qid != null)
  await promise.wait(5)
  t.assert(await redis.zScore(indexKey, member) === null, 'the quarantined changes are no longer indexed')
  t.assert(await yhub.stream.unquarantine(docRef, /** @type {string} */ (qid)) === 1)
  const score = await redis.zScore(indexKey, member)
  t.assert(score != null && score > t1, 're-injected updates are indexed at their fresh clock')
}

/**
 * The protocol end to end on the shared hub: the fresh half lists documents the moment they are
 * written, pages end at millisecond boundaries and `next === since` means caught up, the persisted
 * half takes over after compaction with the same clocks (trailing awareness does not move them),
 * the changeset carries the same `t` and `diff=true` yields exactly the next change, and a
 * deletion is listed at its time with the document's fetch answering 404.
 *
 * @param {t.TestCase} tc
 */
export const testUpdatedListing = async tc => {
  const { createWsClient } = await utils.createTestCase(tc)
  const since = (await yhub.stream.getTime()) - 1
  const a = await createWsClient({ docid: 'a', waitForSync: true })
  a.ydoc.get().applyDelta(delta.create().insert('hello').done())
  await promise.wait(50)
  const b = await createWsClient({ docid: 'b', waitForSync: true })
  b.ydoc.get().applyDelta(delta.create().insert('hi').done())
  await promise.wait(300)
  const aRef = { org, docid: a.ydoc.guid, branch: 'main' }
  const bRef = { org, docid: b.ydoc.guid, branch: 'main' }
  const page = await list(`since=${since}`)
  t.compare(page.docs.map(d => d.docid), [aRef.docid, bRef.docid], 'both documents, oldest first')
  const [ta, tb] = page.docs.map(d => d.t)
  t.assert(ta < tb && page.next === tb)
  t.compare((await get(`/updated/v1/${org}?since=${since}`, { json: true })).body, page, 'json mode')
  await t.groupAsync('paging', async () => {
    const p1 = await list(`since=${since}&limit=1`)
    t.compare(p1.docs.map(d => d.docid), [aRef.docid])
    t.assert(p1.next === ta)
    const p2 = await list(`since=${p1.next}&limit=1`)
    t.compare(p2.docs.map(d => d.docid), [bRef.docid])
    t.assert(p2.next === tb)
    const p3 = await list(`since=${p2.next}&limit=1`)
    t.assert(p3.docs.length === 0 && p3.next === tb, 'next === since: caught up')
  })
  t.assert((await get(`/changeset/v1/${org}/${bRef.docid}`)).body.t === tb, 'the changeset reports the same clock')
  // presence after the last edit must not count as an update - neither on the stream nor, after
  // compaction, in the persisted row
  await yhub.stream.addMessage(bRef, { type: 'awareness:v1', update: presence() })
  t.assert(await redis.zScore(indexKey, stream.encodeDocUpdatedMember(bRef)) === tb)
  utils.cleanPreviousClients()
  await utils.waitTasksProcessed(yhub)
  await t.groupAsync('the persisted half', async () => {
    t.assert(await redis.zScore(indexKey, stream.encodeDocUpdatedMember(bRef)) === null, 'the index entry left with the stream')
    t.compare((await list(`since=${since}`)).docs.map(d => [d.docid, d.t]), [[aRef.docid, ta], [bRef.docid, tb]], 'same documents, same clocks')
    t.assert(stream.redisClockToMs((await yhub.persistence.retrieveDoc(bRef, {})).lastClock) === tb, 'the row is keyed by the last update')
    t.assert((await get(`/changeset/v1/${org}/${bRef.docid}`)).body.t === tb)
  })
  await t.groupAsync('the consumer loop: a new edit, then the diff since the stored clock', async () => {
    const b2 = await createWsClient({ docid: 'b', waitForSync: true })
    b2.ydoc.get().applyDelta(delta.create().retain(2).insert(' there').done())
    await promise.wait(300)
    const again = await list(`since=${tb}`)
    t.compare(again.docs.map(d => d.docid), [bRef.docid])
    const t2 = again.docs[0].t
    t.assert(t2 > tb && again.next === t2)
    // `from` compares the attribution clocks the server stamped before appending (API.md, Clocks):
    // the first edit was stamped at or before `tb`, the second hundreds of ms later
    const changeset = (await get(`/changeset/v1/${org}/${bRef.docid}?from=${tb + 1}&diff=true`)).body
    t.assert(changeset.t === t2)
    t.compare(changeset.diff, delta.create().modifyAttr('', delta.create().retain(2).insert(' there').done()).done().toJSON(), 'the change alone, keyed by root')
    utils.cleanPreviousClients()
    await promise.wait(5)
    const tombstone = await yhub.deleteDoc(aRef, { by: 'user1' })
    await promise.wait(5)
    // the deletion is indexed twice - the tombstone row at `deletedAt`, the stream's tombstone
    // message a moment later - and the page keeps one entry per document, the newer
    const deleted = (await list(`since=${t2}`)).docs
    t.assert(deleted.length === 1 && deleted[0].docid === aRef.docid && deleted[0].t >= tombstone.deletedAt, 'a deletion is listed at its time')
    const gone = await get(`/changeset/v1/${org}/${aRef.docid}`)
    t.assert(gone.status === 404 && gone.body.code === 'doc-deleted', 'and the fetch says so')
    // the deletion must outlive its stream entry: compaction re-persists the soft-deleted document
    // at the tombstone's clock, so a poller that was away sees the clock move
    await utils.waitTasksProcessed(yhub)
    t.assert(stream.redisClockToMs((await yhub.persistence.retrieveDoc(aRef, {})).lastClock) >= tombstone.deletedAt, 'the row is keyed at the deletion')
    const still = (await list(`since=${t2}`)).docs
    t.assert(still.length === 1 && still[0].docid === aRef.docid && still[0].t >= tombstone.deletedAt, 'still listed after the stream is gone')
  })
}

/**
 * Documents written in one MULTI share a millisecond (or at worst two). A page never splits one -
 * `limit` is soft - so paging with `limit=1` lists each document exactly once.
 *
 * @param {t.TestCase} tc
 */
export const testPagesNeverSplitAMillisecond = async tc => {
  await utils.createTestCase(tc)
  const since = (await yhub.stream.getTime()) - 1
  const docids = ['x', 'y', 'z'].map(s => `${tc.testName}-${s}`)
  const multi = redis.multi()
  docids.forEach(docid => {
    const docRef = { org, docid, branch: 'main' }
    const ydoc = new Y.Doc()
    ydoc.get().insert(0, 'x')
    const update = Y.encodeStateAsUpdate(ydoc)
    const m = { type: 'ydoc:update:v1', update, contentmap: createContentMap(Y.createContentIdsFromUpdate(update), 'user1', []) }
    multi.addMessage(stream.encodeRoomName(docRef, yhub.stream.prefix), indexKey, stream.encodeDocUpdatedMember(docRef), true, Buffer.from(buffer.encodeAny(m)))
  })
  await multi.exec()
  await promise.wait(5)
  /**
   * @type {Array<Listing['docs']>}
   */
  const pages = []
  let cursor = since
  while (pages.length < 5) {
    const page = await list(`since=${cursor}&limit=1`)
    if (page.docs.length === 0) break
    t.assert(page.next === array.last(page.docs).t)
    pages.push(page.docs)
    cursor = page.next
  }
  t.compare(pages.flat().map(d => d.docid).sort(), docids.slice().sort(), 'every document listed exactly once')
  t.assert(pages.every((page, i) => i === 0 || page[0].t > array.last(pages[i - 1]).t), 'no millisecond is split across pages')
}

/**
 * One `authorize('document', …)` per listed document: unreadable documents are filtered out but
 * still move the cursor, a missing org grant is 403, and a failing plugin fails the request rather
 * than silently dropping documents.
 *
 * @param {t.TestCase} tc
 */
export const testPerDocumentAuthorization = async tc => {
  await utils.createTestCase(tc)
  const since = (await yhub.stream.getTime()) - 1
  const publicRef = { org, docid: `${tc.testName}-public`, branch: 'main' }
  const secretRef = { org, docid: `${tc.testName}-secret`, branch: 'main' }
  const pub = new Y.Doc()
  await appendEdit(publicRef, pub, () => pub.get().insert(0, 'public'))
  await promise.wait(5)
  const sec = new Y.Doc()
  const tSecret = await appendEdit(secretRef, sec, () => sec.get().insert(0, 'secret'))
  await promise.wait(5)
  const host = `localhost:${authPort}`
  const page = await get(`/updated/v1/${org}?since=${since}`, { host, user: 'reader' })
  t.assert(page.status === 200)
  const listing = /** @type {Listing} */ (page.body)
  t.compare(listing.docs.map(d => d.docid), [publicRef.docid], 'unreadable documents are filtered out')
  t.assert(listing.next === tSecret, 'but still advance the cursor')
  t.assert((await get(`/updated/v1/${org}?since=${since}`, { host, user: 'nobody' })).status === 403, 'no org grant')
  const broken = await get(`/updated/v1/${org}?since=${since}`, { host, user: 'broken' })
  t.assert(broken.status === 503 && broken.body.code === 'auth-unavailable', 'a failing plugin fails the request')
}
