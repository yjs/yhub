import * as Y from '@y/y'
import * as t from 'lib0/testing'
import * as promise from 'lib0/promise'
import * as array from 'lib0/array'
import * as buffer from 'lib0/buffer'
import * as delta from 'lib0/delta'
import * as awarenessProtocol from '@y/protocols/awareness'
import * as types from '../src/types.js'
import * as stream from '../src/stream.js'
import { createDocumentPermissions, hasPermissions, normalizeDocumentPermissions } from '../src/permissions.js'
import { createContentMap } from '../src/y-utils.js'
import * as utils from './utils.js'

/**
 * The updated-documents listing (`GET /updated`): the redis index that shares its lifetime with a
 * document's stream, the persisted half, the cursor protocol, the batch permission check, and the
 * changeset's `t` and `diff` that a poller consumes.
 */

const { yhub, defaultOrg: org } = utils
const redis = yhub.stream.redis
const indexKey = stream.encodeDocUpdatedKey(org, yhub.stream.prefix)
const orgIndexKey = stream.encodeOrgUpdatedKey(yhub.stream.prefix)
const orgLastChangeKey = stream.encodeOrgLastChangeKey(yhub.stream.prefix)

/**
 * The learn clock of `o` - the score of the member its last-change clock names.
 *
 * @param {string} o
 */
const learnedOf = async o => {
  const lastChange = await redis.hGet(orgLastChangeKey, o)
  return lastChange == null ? null : redis.zScore(orgIndexKey, stream.encodeOrgUpdatedMember(o, lastChange))
}

/**
 * The calls of the auth hub's batch check, in order.
 *
 * @type {Array<{ docRefs: Array<import('../src/types.js').DocRef>, required: import('../src/permissions.js').DocumentPermissionsV1, userid: string|null }>}
 */
const filterCalls = []

/**
 * The auth hub's grant on every document it lets a user read.
 */
const readGrant = createDocumentPermissions({ ydoc: '-r--' })
const normalizedReadGrant = normalizeDocumentPermissions(readGrant)

/**
 * Whether the auth hub lets `user` read `docRef` - its `authorize` and `filterAuthorized` both
 * answer from this, so they agree: docids ending in `-secret` are unreadable, and `broken`'s
 * document checks fail.
 *
 * @param {import('../src/types.js').DocRef} docRef
 * @param {{ userid: string } | null} user
 */
const mayRead = (docRef, user) => {
  if (user?.userid === 'broken') throw new Error('permission backend down')
  return !docRef.docid.endsWith('-secret')
}

/**
 * A hub whose auth plugin answers per document (`mayRead`), `nobody` holds no org grant and no
 * orgs, `noglobal` no global grant, and the batch check of `copies` answers each unreadable
 * document under another org, then equal copies of the readable ones instead of the given objects.
 * Globally, `reader` has every org (`orgs: '*'`) and `orgs=a,b` the listed ones. Same redis and
 * postgres as the shared hub, so what is written there is listed here.
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
        global: async (_resource, user) => {
          const userid = user?.userid ?? ''
          if (userid === 'noglobal') return null
          /**
           * @type {'*' | Array<string> | undefined}
           */
          const orgs = userid.startsWith('orgs=') ? userid.slice(5).split(',') : (userid === 'reader' ? '*' : undefined)
          return { type: 'permissions:global:v1', endpoint: { updated: '-r--' }, ...(orgs === undefined ? {} : { orgs }) }
        },
        org: async (_org, user) => user?.userid === 'nobody' ? null : { type: 'permissions:org:v1', endpoint: { updated: '-r--' } },
        document: async (docRef, user) => mayRead(docRef, user) ? readGrant : null
      }),
      filterAuthorized: {
        document: async (docRefs, required, user) => {
          filterCalls.push({ docRefs, required, userid: user?.userid ?? null })
          const readable = hasPermissions(normalizedReadGrant, required) ? docRefs.filter(docRef => mayRead(docRef, user)) : []
          return user?.userid !== 'copies'
            ? readable
            : docRefs.filter(docRef => !mayRead(docRef, user)).map(docRef => ({ ...docRef, org: `${docRef.org}-other` })).concat(readable.map(docRef => ({ ...docRef })))
        }
      }
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
  const { docs, now } = await yhub.stream.getUpdatedDocs(org, { from: t1 })
  t.compare(docs, [{ docid: docRef.docid, branch: docRef.branch, t: t2 }])
  t.assert(now >= t2, 'with the redis time after the read')
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
    // a document in both sources at one clock - a redis entry at its last update, the row at the
    // same clock - fills a page of one twice over; it is listed once and the cursor moves past it
    await redis.zAdd(indexKey, { score: tb, value: stream.encodeDocUpdatedMember(bRef) })
    const p1 = await list(`since=${ta}&limit=1`)
    t.compare(p1.docs.map(d => d.docid), [bRef.docid])
    t.assert(p1.next === tb)
    t.assert((await list(`since=${tb}&limit=1`)).next === tb, 'caught up')
    await redis.zRem(indexKey, stream.encodeDocUpdatedMember(bRef))
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
 * All pages of `limit` after `since`, each ending at its last document's clock.
 *
 * @param {number} since
 * @param {number} limit
 */
const pagesOf = async (since, limit) => {
  /**
   * @type {Array<Listing['docs']>}
   */
  const pages = []
  let cursor = since
  while (pages.length < 5) {
    const page = await list(`since=${cursor}&limit=${limit}`)
    if (page.docs.length === 0) break
    t.assert(page.next === array.last(page.docs).t)
    pages.push(page.docs)
    cursor = page.next
  }
  return pages
}

/**
 * Documents written in one MULTI share a millisecond (or at worst two). A page never splits one -
 * `limit` is soft - so paging with `limit=1` lists each document exactly once. Likewise in the
 * persisted half: deletions recorded at one `deletedAt` are more than a page of one or two holds,
 * and none is skipped.
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
  const pages = await pagesOf(since, 1)
  t.compare(pages.flat().map(d => d.docid).sort(), docids.slice().sort(), 'every document listed exactly once')
  t.assert(pages.every((page, i) => i === 0 || page[0].t > array.last(pages[i - 1]).t), 'no millisecond is split across pages')
  await t.groupAsync('the persisted half', async () => {
    const gone = ['p', 'q', 'r'].map(s => ({ org, docid: `${tc.testName}-${s}`, branch: 'main' }))
    await promise.all(gone.map(docRef => yhub.persistence.deleteTombstone(docRef)))
    const deletedAt = await yhub.stream.getTime()
    await promise.all(gone.map(docRef => yhub.persistence.storeTombstone(docRef, { deletedAt, hard: false, by: null })))
    await promise.wait(5)
    for (const limit of [1, 2]) {
      const pages = await pagesOf(deletedAt - 1, limit)
      t.assert(pages.length === 1 && pages[0].every(d => d.t === deletedAt), 'one page holds the whole millisecond')
      t.compare(pages[0].map(d => d.docid).sort(), gone.map(d => d.docid), `limit=${limit}: none is skipped`)
    }
    await promise.all(gone.map(docRef => yhub.persistence.deleteTombstone(docRef)))
  })
  t.compare((await list(`since=${since}&limit=5000`)).docs.map(d => d.docid).sort(), docids.slice().sort(), 'a limit above 1000 is accepted')
}

/**
 * A page ends before the millisecond it was read in: that millisecond is still open, and a
 * document listed in it could change again at the same `t`. A document whose last change is ahead
 * of redis's time - a stream clock after a clock step-back - waits until the clock passed it.
 *
 * @param {t.TestCase} tc
 */
export const testPageEndsBeforeTheOpenMillisecond = async tc => {
  const { defaultDocRef: docRef } = await utils.createTestCase(tc)
  const since = (await yhub.stream.getTime()) - 1
  const ydoc = new Y.Doc()
  const t1 = await appendEdit(docRef, ydoc, () => ydoc.get().insert(0, 'hello'))
  await promise.wait(5)
  const ahead = stream.encodeDocUpdatedMember({ org, docid: `${tc.testName}-ahead`, branch: 'main' })
  await redis.zAdd(indexKey, { score: (await yhub.stream.getTime()) + 60000, value: ahead })
  const page = await list(`since=${since}`)
  await redis.zRem(indexKey, ahead)
  t.compare(page.docs.map(d => d.docid), [docRef.docid], 'a closed millisecond is listed, a later one is not')
  t.assert(page.next === t1, 'and next stays before it')
}

/**
 * One `filterAuthorized` call per page, with every listed document and the ydoc `r` requirement:
 * unreadable documents are filtered out but still move the cursor, a missing org grant is 403, a
 * failing plugin fails the request rather than silently dropping documents, the answer is matched
 * by value (equal copies in any order; an entry of another org lists nothing), and an empty page
 * asks nothing.
 *
 * @param {t.TestCase} tc
 */
export const testFilterAuthorized = async tc => {
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
  filterCalls.length = 0
  const page = await get(`/updated/v1/${org}?since=${since}`, { host, user: 'reader' })
  t.assert(page.status === 200)
  const listing = /** @type {Listing} */ (page.body)
  t.compare(listing.docs.map(d => d.docid), [publicRef.docid], 'unreadable documents are filtered out')
  t.assert(listing.next === tSecret, 'but still advance the cursor')
  t.compare(filterCalls, [{ docRefs: [publicRef, secretRef], required: createDocumentPermissions({ ydoc: '-r--' }), userid: 'reader' }], 'one batch check with every listed document')
  t.assert((await get(`/updated/v1/${org}?since=${since}`, { host, user: 'nobody' })).status === 403, 'no org grant')
  const broken = await get(`/updated/v1/${org}?since=${since}`, { host, user: 'broken' })
  t.assert(broken.status === 503 && broken.body.code === 'auth-unavailable', 'a failing plugin fails the request')
  t.compare((await get(`/updated/v1/${org}?since=${since}`, { host, user: 'copies' })).body, listing, 'the answer is matched by value - not by identity, position, or docid alone')
  filterCalls.length = 0
  const empty = await get(`/updated/v1/${org}?since=${tSecret}`, { host, user: 'reader' })
  t.compare(empty.body, { docs: [], next: tSecret }, 'caught up')
  t.assert(filterCalls.length === 0, 'an empty page asks nothing')
}

/**
 * A content message marks its org in memory at its stream clock, awareness does not. A flush raises
 * the org's last-change clock (`org_last_change`) and stamps the org with the time the index learned
 * of it (`org_updated`) - but only when its clock went up: a lower or equal clock changes neither.
 *
 * @param {t.TestCase} tc
 */
export const testOrgIndexFlush = async tc => {
  await utils.createTestCase(tc)
  const o = `${tc.testName}-org`
  const quiet = `${tc.testName}-quiet`
  await yhub.stream.addMessage({ org: quiet, docid: 'd', branch: 'main' }, { type: 'awareness:v1', update: presence() })
  const ydoc = new Y.Doc()
  const t1 = await appendEdit({ org: o, docid: 'a', branch: 'main' }, ydoc, () => ydoc.get().insert(0, 'hello'))
  t.assert(yhub.stream._orgUpdates.get(o) === t1, 'collected in memory at the stream clock')
  await stream.flushOrgUpdates(yhub.stream)
  t.assert(yhub.stream._orgUpdates.size === 0, 'cleared by the flush')
  t.assert(Number(await redis.hGet(orgLastChangeKey, o)) === t1)
  const learned1 = /** @type {number} */ (await learnedOf(o))
  t.assert(learned1 >= t1, 'stamped when the index learned of it')
  t.assert(await redis.hGet(orgLastChangeKey, quiet) == null && await learnedOf(quiet) === null, 'awareness does not mark the org')
  await promise.wait(5)
  const other = new Y.Doc()
  const t2 = await appendEdit({ org: o, docid: 'b', branch: 'main' }, other, () => other.get().insert(0, 'x'))
  await stream.flushOrgUpdates(yhub.stream)
  const learned2 = /** @type {number} */ (await learnedOf(o))
  t.assert(t2 > t1 && Number(await redis.hGet(orgLastChangeKey, o)) === t2 && learned2 > learned1, 'the last change over all documents of the org, stamped anew')
  await promise.wait(5)
  for (const tLower of [t1, t2]) {
    stream.markOrgUpdated(yhub.stream, o, tLower)
    await stream.flushOrgUpdates(yhub.stream)
  }
  t.assert(Number(await redis.hGet(orgLastChangeKey, o)) === t2 && await learnedOf(o) === learned2, 'a lower or equal clock restamps nothing')
  const members = (await redis.zRange(orgIndexKey, 0, -1)).filter(m => stream.decodeOrgUpdatedMember(m).org === o)
  t.compare(members, [stream.encodeOrgUpdatedMember(o, t2)], 'one member per org - the restamp swapped it')
}

/**
 * A failed flush is merged back and written by the next one. While redis is not ready the write is
 * not even sent - node-redis would queue it, and `destroy` would wait for it.
 *
 * @param {t.TestCase} tc
 */
export const testOrgIndexFlushFailure = async tc => {
  await utils.createTestCase(tc)
  const o = `${tc.testName}-org`
  const tm = await yhub.stream.getTime()
  const anyRedis = /** @type {any} */ (redis)
  anyRedis.updateOrgs = () => promise.reject(new Error('redis down'))
  try {
    stream.markOrgUpdated(yhub.stream, o, tm)
    await stream.flushOrgUpdates(yhub.stream)
  } finally {
    delete anyRedis.updateOrgs
  }
  t.assert(yhub.stream._orgUpdates.get(o) === tm, 'merged back')
  Object.defineProperty(redis, 'isReady', { value: false, configurable: true })
  try {
    await stream.flushOrgUpdates(yhub.stream)
  } finally {
    delete anyRedis.isReady
  }
  // the shared redis keeps the orgs of earlier runs
  t.assert(yhub.stream._orgUpdates.get(o) === tm && Number(await redis.hGet(orgLastChangeKey, o) ?? 0) < tm, 'not sent while redis is not ready - merged back')
  await stream.flushOrgUpdates(yhub.stream)
  t.assert(Number(await redis.hGet(orgLastChangeKey, o)) === tm && await learnedOf(o) !== null, 'written by the next flush')
}

/**
 * A batch lost before its flush (a crashed process) is repaired by the worker, which reports the
 * org before it trims the stream - while a compaction of a change the index already knows restamps
 * nothing. `unsafePersistDoc` has no stream message and writes right away. `destroy` flushes what
 * is left.
 *
 * @param {t.TestCase} tc
 */
export const testOrgIndexRepair = async tc => {
  await utils.createTestCase(tc)
  await t.groupAsync('the worker repairs a lost batch, and restamps nothing it already knows', async () => {
    const lost = `${tc.testName}-lost`
    const known = `${tc.testName}-known`
    const ydoc = new Y.Doc()
    const t1 = await appendEdit({ org: lost, docid: 'a', branch: 'main' }, ydoc, () => ydoc.get().insert(0, 'hello'))
    yhub.stream._orgUpdates.delete(lost)
    const other = new Y.Doc()
    await appendEdit({ org: known, docid: 'a', branch: 'main' }, other, () => other.get().insert(0, 'hello'))
    await stream.flushOrgUpdates(yhub.stream)
    const learned = await learnedOf(known)
    // the shared redis keeps the orgs of earlier runs
    const lostBefore = (await learnedOf(lost)) ?? 0
    t.assert(Number(await redis.hGet(orgLastChangeKey, lost) ?? 0) < t1, 'the batch never arrived')
    await utils.waitTasksProcessed(yhub)
    t.assert(Number(await redis.hGet(orgLastChangeKey, lost)) === t1 && /** @type {number} */ (await learnedOf(lost)) > lostBefore, 'repaired')
    t.assert(await learnedOf(known) === learned, 'not restamped by its compaction')
  })
  await t.groupAsync('unsafePersistDoc', async () => {
    const docRef = { org: `${tc.testName}-unsafe`, docid: 'a', branch: 'main' }
    const ydoc = new Y.Doc()
    ydoc.get().insert(0, 'x')
    await yhub.unsafePersistDoc(docRef, Y.encodeStateAsUpdate(ydoc), {})
    const created = stream.redisClockToMs((await yhub.persistence.retrieveDoc(docRef, {})).lastClock)
    t.assert(!yhub.stream._orgUpdates.has(docRef.org) && Number(await redis.hGet(orgLastChangeKey, docRef.org)) === created)
  })
  await t.groupAsync('destroy flushes', async () => {
    const hub = await utils.createTestHub({})
    const o = `${tc.testName}-destroyed`
    const ydoc = new Y.Doc()
    ydoc.get().insert(0, 'x')
    const update = Y.encodeStateAsUpdate(ydoc)
    const id = await hub.stream.addMessage({ org: o, docid: 'a', branch: 'main' }, { type: 'ydoc:update:v1', update, contentmap: createContentMap(Y.createContentIdsFromUpdate(update), 'user1', []) })
    await hub.destroy()
    t.assert(Number(await redis.hGet(orgLastChangeKey, o)) === stream.redisClockToMs(id))
    // a mark after destroy (a write that finished late) is dropped - no timer against the closed client
    stream.markOrgUpdated(hub.stream, o, stream.redisClockToMs(id) + 1)
    t.assert(hub.stream._orgUpdatesTimeout === null && hub.stream._orgUpdates.size === 0, 'dropped after destroy')
    // a write still waiting for redis when destroy starts (the server does not await its writes) -
    // its mark reaches the final flush
    const s = await stream.createStream(yhub.conf)
    const inflight = `${tc.testName}-inflight`
    const pending = s.addMessage({ org: inflight, docid: 'a', branch: 'main' }, { type: 'ydoc:update:v1', update, contentmap: createContentMap(Y.createContentIdsFromUpdate(update), 'user1', []) })
    await s.destroy()
    t.assert(Number(await redis.hGet(orgLastChangeKey, inflight)) === stream.redisClockToMs(await pending), 'a write in flight is flushed by destroy')
  })
}

/**
 * `GET /updated/v1` (global scope): the orgs the index learned a change of after `since`, oldest
 * first, with their last-change clock `t` - `next` is a learn clock. The global endpoint grant gates
 * it, the global `orgs` facet restricts it - and without that facet the request is refused.
 *
 * @param {t.TestCase} tc
 */
export const testUpdatedOrgsListing = async tc => {
  await utils.createTestCase(tc)
  // the marks of earlier tests must not be stamped after `since`
  await stream.flushOrgUpdates(yhub.stream)
  const since = (await yhub.stream.getTime()) - 1
  const orgs = ['a', 'b'].map(s => `${tc.testName}-${s}`)
  /**
   * @type {Array<number>}
   */
  const ts = []
  for (const o of orgs) {
    const ydoc = new Y.Doc()
    ts.push(await appendEdit({ org: o, docid: 'd', branch: 'main' }, ydoc, () => ydoc.get().insert(0, 'x')))
    await stream.flushOrgUpdates(yhub.stream)
    await promise.wait(5)
  }
  const learned = await promise.all(orgs.map(o => learnedOf(o)))
  const host = `localhost:${authPort}`
  const page = await get(`/updated/v1?since=${since}`, { host, user: 'reader' })
  t.assert(page.status === 200)
  t.compare(page.body, { orgs: orgs.map((org, i) => ({ org, t: ts[i] })), next: learned[1] }, "orgs: '*' - both orgs, oldest first")
  t.compare((await get(`/updated/v1?since=${since}&limit=1`, { host, user: 'reader' })).body, { orgs: [{ org: orgs[0], t: ts[0] }], next: learned[0] }, 'an explicit limit')
  t.compare((await get(`/updated/v1?since=${since}`, { host, user: 'reader', json: true })).body, page.body, 'json mode')
  t.compare((await get(`/updated/v1?since=${learned[1]}`, { host, user: 'reader' })).body, { orgs: [], next: learned[1] }, 'next === since: caught up')
  t.compare((await get(`/updated/v1?since=${since}`, { host, user: `orgs=${orgs[0]},${tc.testName}-unknown` })).body, { orgs: [{ org: orgs[0], t: ts[0] }], next: learned[0] }, 'a list - only the listed orgs')
  t.compare(await yhub.stream.getUpdatedOrgs({ since, orgs: [] }), { orgs: [], next: since }, 'an empty list - no org')
  const noOrgs = await get(`/updated/v1?since=${since}`, { host, user: 'nobody' })
  t.assert(noOrgs.status === 403 && noOrgs.body.code === 'missing-permission' && noOrgs.body.required === undefined, 'no orgs facet - refused, without `required`')
  t.assert((await get(`/updated/v1?since=${since}`, { host, user: 'noglobal' })).status === 403, 'no global grant')
}

/**
 * What the learn clock is for: a change that reaches the index after a cursor moved past its own
 * clock - another process's batch, a crash the worker repairs - is still listed, at its own `t`.
 * And `next` never names the millisecond a page was read in: a stamp at or after it is listed, and
 * listed again on the next page, so one minted later in that millisecond is never behind it. A
 * clock behind the latest stamp (redis's clock stepped back) stamps past it, and a change clock
 * ahead of every stamp (a stream's clock after such a step) stamps at it. The stamp ahead of the
 * clock goes to an index of its own: on the shared one, every org stamped meanwhile - by any
 * process - would be stamped past it, and outlive the cleanup.
 *
 * @param {t.TestCase} tc
 */
export const testUpdatedOrgsLateChange = async tc => {
  await utils.createTestCase(tc)
  const host = `localhost:${authPort}`
  await stream.flushOrgUpdates(yhub.stream)
  const now = await yhub.stream.getTime()
  const early = `${tc.testName}-early`
  const late = `${tc.testName}-late`
  await stream.writeOrgsUpdated(yhub.stream, new Map([[early, now - 1000]]))
  await promise.wait(2)
  const p1 = (await get(`/updated/v1?since=${now - 1}`, { host, user: 'reader' })).body
  t.compare(p1.orgs, [{ org: early, t: now - 1000 }])
  // arrives after the cursor moved on, with a change clock far behind it
  await stream.writeOrgsUpdated(yhub.stream, new Map([[late, now - 2000]]))
  await promise.wait(2)
  const p2 = (await get(`/updated/v1?since=${p1.next}`, { host, user: 'reader' })).body
  t.compare(p2.orgs, [{ org: late, t: now - 2000 }], 'listed after the cursor, at its own clock')
  t.assert(p2.next > p1.next)
  const ahead = await stream.createStream({ ...yhub.conf, redis: { ...yhub.conf.redis, prefix: `${yhub.stream.prefix}:${tc.testName}` } })
  try {
    const future = `${tc.testName}-future`
    const stepped = `${tc.testName}-stepped`
    await ahead.redis.zAdd(ahead.orgUpdatedKey, { value: stream.encodeOrgUpdatedMember(future, now), score: now + 60000 })
    await ahead.redis.hSet(ahead.orgLastChangeKey, future, String(now))
    const p3 = await ahead.getUpdatedOrgs({ since: now, orgs: '*' })
    t.compare(p3.orgs, [{ org: future, t: now }], 'a stamp ahead of the read is listed')
    t.assert(p3.next >= now && p3.next < now + 60000, 'but next stays before the millisecond of the read')
    t.compare((await ahead.getUpdatedOrgs({ since: p3.next, orgs: '*' })).orgs, [{ org: future, t: now }], 'so it is listed again')
    await stream.writeOrgsUpdated(ahead, new Map([[stepped, now]]))
    t.assert(await ahead.redis.zScore(ahead.orgUpdatedKey, stream.encodeOrgUpdatedMember(stepped, now)) === now + 60001, 'a clock behind the latest stamp - stamped past it')
    // after a step a stream's clock runs ahead of redis's - the org-level listing shows the change
    // only once the clock passed it, so the cursor must not pass the org before then
    const streamAhead = `${tc.testName}-stream-ahead`
    await stream.writeOrgsUpdated(ahead, new Map([[streamAhead, now + 120000]]))
    t.assert(await ahead.redis.zScore(ahead.orgUpdatedKey, stream.encodeOrgUpdatedMember(streamAhead, now + 120000)) === now + 120000, 'a change clock ahead of every stamp - stamped at it')
    const p4 = await ahead.getUpdatedOrgs({ since: now + 60001, orgs: '*' })
    t.compare(p4.orgs, [{ org: streamAhead, t: now + 120000 }])
    t.assert(p4.next < now + 120000, 'and next stays before it')
  } finally {
    await ahead.redis.del([ahead.orgUpdatedKey, ahead.orgLastChangeKey, ahead.workerStreamName])
    await ahead.destroy()
  }
}

/**
 * Orgs learned in the same millisecond are never split across pages - `limit` is soft. One flush
 * stamps all its orgs alike. Both for `orgs: '*'` (a range read of the index) and for a list (the
 * listed orgs' entries).
 *
 * @param {t.TestCase} tc
 */
export const testUpdatedOrgsPagesNeverSplitAMillisecond = async tc => {
  await utils.createTestCase(tc)
  await stream.flushOrgUpdates(yhub.stream)
  const tm = (await yhub.stream.getTime()) - 1
  const orgs = ['x', 'y', 'z'].map(s => `${tc.testName}-${s}`)
  await stream.writeOrgsUpdated(yhub.stream, new Map([[orgs[0], tm], [orgs[1], tm]]))
  await stream.writeOrgsUpdated(yhub.stream, new Map([[orgs[2], tm + 1]]))
  await promise.wait(2)
  const [lx, ly, lz] = /** @type {Array<number>} */ (await promise.all(orgs.map(o => learnedOf(o))))
  t.assert(lx === ly && lz > lx, 'one flush, one learned millisecond - the next flush strictly after it, even within the same millisecond')
  const host = `localhost:${authPort}`
  for (const user of ['reader', `orgs=${orgs.join(',')}`]) {
    await t.groupAsync(user, async () => {
      const p1 = (await get(`/updated/v1?since=${lx - 1}&limit=1`, { host, user })).body
      t.compare(p1.orgs.map((/** @type {{ org: string }} */ o) => o.org).sort(), [orgs[0], orgs[1]], 'the millisecond at the end is read whole')
      t.assert(p1.next === lx)
      const p2 = (await get(`/updated/v1?since=${p1.next}&limit=1`, { host, user })).body
      t.compare(p2, { orgs: [{ org: orgs[2], t: tm + 1 }], next: lz })
      const p3 = (await get(`/updated/v1?since=${p2.next}&limit=1`, { host, user })).body
      t.compare(p3, { orgs: [], next: lz }, 'caught up')
    })
  }
}

/**
 * Without `limit` one page lists up to 10000 orgs learned after `since`. Each org is stamped in a
 * millisecond of its own, so it is the large default, not a whole millisecond, that keeps them on
 * one page.
 *
 * @param {t.TestCase} tc
 */
export const testUpdatedOrgsDefaultLimit = async tc => {
  await utils.createTestCase(tc)
  await stream.flushOrgUpdates(yhub.stream)
  const since = (await yhub.stream.getTime()) - 1
  const orgs = array.unfold(101, i => `${tc.testName}-${i}`)
  for (const o of orgs) {
    await stream.writeOrgsUpdated(yhub.stream, new Map([[o, since]]))
    await promise.wait(1)
  }
  const host = `localhost:${authPort}`
  /**
   * @param {string} query
   */
  const listed = async query => (await get(`/updated/v1?since=${since}${query}`, { host, user: 'reader' })).body.orgs.map((/** @type {{ org: string }} */ o) => o.org).filter((/** @type {string} */ o) => o.startsWith(`${tc.testName}-`))
  t.compare(await listed(''), orgs, 'every org, oldest first')
  t.compare(await listed('&limit=100'), orgs.slice(0, 100), 'an explicit limit still pages')
}
