import * as Y from '@y/y'
import * as t from 'lib0/testing'
import * as promise from 'lib0/promise'
import * as buffer from 'lib0/buffer'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as utils from './utils.js'
import { isSmallerRedisClock } from '../src/stream.js'
import { wsCloseDocDeleted } from '../src/server.js'

/**
 * @param {Response} response
 */
const readBody = async response => {
  const data = await response.arrayBuffer()
  // only x-lib0any bodies are any-decodable - changeset/activity answer with raw octet-stream, and
  // readAny on those throws or silently yields garbage depending on the first byte
  return (response.headers.get('content-type') ?? '').includes('x-lib0any') && data.byteLength > 0
    ? decoding.readAny(decoding.createDecoder(new Uint8Array(data)))
    : null
}

/**
 * @param {string} path
 * @param {string} [method]
 */
const yhubRequest = async (path, method = 'GET') => {
  const response = await fetch(`http://${utils.yhubHost}${path}`, { method })
  return { status: response.status, body: await readBody(response) }
}

/**
 * @param {string} path
 * @param {any} body
 * @param {string} [method]
 */
const yhubPost = async (path, body, method = 'POST') => {
  const encoder = encoding.createEncoder()
  encoding.writeAny(encoder, body)
  const response = await fetch(`http://${utils.yhubHost}${path}`, {
    method,
    headers: { 'Content-Type': 'application/octet-stream' },
    body: encoding.toUint8Array(encoder)
  })
  return { status: response.status, body: await readBody(response) }
}

/**
 * @param {string} path
 * @param {any} body
 */
const yhubPatch = async (path, body) => {
  const encoder = encoding.createEncoder()
  encoding.writeAny(encoder, body)
  const response = await fetch(`http://${utils.yhubHost}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: encoding.toUint8Array(encoder)
  })
  return { status: response.status, body: await readBody(response) }
}

/**
 * Disconnect the test's websocket clients, the way a client that understood the deleted close
 * code would. `@y/websocket` reconnects on every close code, and an awareness message from a
 * reconnecting client can reach the server while the initial sync is still deciding to refuse
 * it - which re-creates the very stream key the deletion cleared. Tests that wait for the
 * stream to drain therefore have to let the clients go first.
 */
const dropClients = () => utils.cleanPreviousClients()

/**
 * The parts `Persistence.store` needs, derived from a ydoc the way `unsafePersistDoc` does.
 *
 * @param {Y.Doc} ydoc
 */
const encodeDocForStore = ydoc => {
  const update = Y.encodeStateAsUpdate(ydoc)
  const contentids = Y.createContentIdsFromUpdate(update)
  return {
    gcDoc: update,
    nongcDoc: update,
    contentids: Y.encodeContentIds(contentids),
    contentmap: Y.encodeContentMap(Y.createContentMapFromContentIds(contentids, [], []))
  }
}

/**
 * @param {import('../src/index.js').YHub} yhub
 * @param {import('../src/types.js').DocRef} docRef
 */
const listS3Objects = async (yhub, docRef) => {
  const s3 = /** @type {any} */ (yhub.conf.persistence[0])
  const prefix = `id:ydoc:v1/${encodeURIComponent(docRef.org)}/${encodeURIComponent(docRef.docid)}/${encodeURIComponent(docRef.branch)}/`
  /**
   * @type {Array<string>}
   */
  const names = []
  for await (const obj of s3.s3client.listObjectsV2(s3.bucket, prefix, true)) {
    obj.name != null && names.push(obj.name)
  }
  return names
}

/**
 * @param {import('../src/index.js').YHub} yhub
 * @param {import('../src/types.js').DocRef} docRef
 */
const readDoc = async (yhub, docRef) => {
  const { gcDoc } = await yhub.getDoc(docRef, { gc: true })
  const ydoc = new Y.Doc()
  gcDoc && Y.applyUpdate(ydoc, gcDoc)
  return ydoc
}

/**
 * A soft deletion only records that the document is gone. Its content is left alone and
 * compaction keeps running, so updates that were still on the stream are persisted rather than
 * trimmed away unpersisted.
 *
 * @param {t.TestCase} tc
 */
export const testSoftDeleteKeepsContent = async tc => {
  const { createWsClient, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const { ydoc } = await createWsClient({ waitForSync: true })
  ydoc.get().setAttr('a', 1)
  await promise.wait(500)
  const tombstone = await yhub.deleteDoc(defaultDocRef, { by: 'user1' })
  t.assert(tombstone.hard === false, 'soft by default')
  t.assert(tombstone.purgedAt === null, 'a soft deletion erases nothing')
  t.assert(tombstone.by === 'user1' && tombstone.deletedAt > 0)
  t.assert((await yhub.getDoc(defaultDocRef, { gc: true })).tombstone != null, 'getDoc reports the deletion')
  // the update was still on the stream when the document was deleted - the worker persists it
  dropClients()
  await utils.waitTasksProcessed(yhub)
  const persisted = await yhub.persistence.retrieveDoc(defaultDocRef, { gc: true })
  t.assert(persisted.gcDoc.length > 0, 'a soft deletion does not stop compaction')
  t.assert((await readDoc(yhub, defaultDocRef)).get().getAttr('a') === 1, 'the content survived')
}

/**
 * @param {t.TestCase} tc
 */
export const testRestoreDoc = async tc => {
  const { createWsClient, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const { ydoc } = await createWsClient({ waitForSync: true })
  ydoc.get().setAttr('a', 1)
  await promise.wait(500)
  await yhub.deleteDoc(defaultDocRef)
  t.assert((await yhub.getDoc(defaultDocRef, { gc: true })).tombstone != null, 'getDoc reports the deletion')
  await yhub.restoreDoc(defaultDocRef)
  t.assert(await yhub.persistence.retrieveTombstone(defaultDocRef) === null, 'the tombstone is gone')
  const restored = await yhub.getDoc(defaultDocRef, { gc: true })
  const check = new Y.Doc()
  Y.applyUpdate(check, restored.gcDoc)
  t.assert(check.get().getAttr('a') === 1, 'the document came back with its content')
  // restoring what was never deleted is a no-op, not an error
  await yhub.restoreDoc(defaultDocRef)
}

/**
 * @param {t.TestCase} tc
 */
export const testRestoreRefusesErasedContent = async tc => {
  const { yhub, defaultDocRef } = await utils.createTestCase(tc)
  await yhub.deleteDoc(defaultDocRef, { hard: true })
  // the content is gone, so dropping the record would resurrect a partial document
  await t.failsAsync(() => yhub.restoreDoc(defaultDocRef))
  t.assert(await yhub.persistence.retrieveTombstone(defaultDocRef) != null, 'the record is still there')
}

/**
 * @param {t.TestCase} tc
 */
export const testHardDeleteErasesContent = async tc => {
  const { createWsClient, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const { ydoc } = await createWsClient({ waitForSync: true })
  ydoc.get().setAttr('a', 1)
  await promise.wait(500)
  // compact first, so there is something in postgres and in s3 to erase
  await utils.waitTasksProcessed(yhub)
  t.assert((await yhub.persistence.retrieveDoc(defaultDocRef, { gc: true })).gcDoc.length > 0, 'rows exist')
  t.assert((await listS3Objects(yhub, defaultDocRef)).length > 0, 's3 objects exist')
  const tombstone = await yhub.deleteDoc(defaultDocRef, { hard: true })
  t.assert(tombstone.hard && tombstone.purgedAt != null, 'the returned record reports the completed purge')
  t.assert((await yhub.persistence.retrieveDoc(defaultDocRef, { gc: true })).gcDoc.length === 0, 'no rows left')
  // the rows go first and the assets follow on the plugin's schedule (S3PersistenceV1 defers to
  // let concurrent readers finish), so converge rather than expecting them gone on return
  await promise.untilAsync(async () => (await listS3Objects(yhub, defaultDocRef)).length === 0, 30000)
  t.assert((await listS3Objects(yhub, defaultDocRef)).length === 0, 'the s3 objects are erased too')
  // deleting again purges again, finds nothing left and stays happy - which is what makes the
  // retention sweep safe to re-run over a document it already handled
  const again = await yhub.deleteDoc(defaultDocRef, { hard: true })
  t.assert(again.purgedAt != null && again.deletedAt === tombstone.deletedAt, 're-purging is a no-op')
  t.assert((await yhub.persistence.retrieveDoc(defaultDocRef, { gc: true })).gcDoc.length === 0, 'still no rows')
}

/**
 * The guard that closes the race: a compact task can spend minutes merging between reading the
 * document's state and calling `store`, so a deletion that lands in that window is only caught
 * inside the insert itself.
 *
 * @param {t.TestCase} tc
 */
export const testHardDeleteBlocksPersistence = async tc => {
  const { yhub, defaultDocRef } = await utils.createTestCase(tc)
  const ydoc = new Y.Doc()
  ydoc.get().setAttr('a', 1)
  await yhub.deleteDoc(defaultDocRef, { hard: true })
  // a compaction that started before the deletion still arrives here
  await yhub.persistence.store(defaultDocRef, { lastClock: `${await yhub.stream.getTime()}-0`, ...encodeDocForStore(ydoc) })
  t.assert((await yhub.persistence.retrieveDoc(defaultDocRef, { gc: true })).gcDoc.length === 0, 'store is refused')
  // and so does unsafePersistDoc, which bypasses the stream and the api entirely
  await yhub.unsafePersistDoc(defaultDocRef, Y.encodeStateAsUpdate(ydoc), { by: 'user1' })
  t.assert((await yhub.persistence.retrieveDoc(defaultDocRef, { gc: true })).gcDoc.length === 0, 'unsafePersistDoc is refused')
  // a soft deletion deliberately does not block it - reach past restoreDoc, which refuses to
  // undo a hard deletion, to get the document back to a soft-deleted state
  await yhub.persistence.deleteTombstone(defaultDocRef)
  await yhub.deleteDoc(defaultDocRef)
  await yhub.persistence.store(defaultDocRef, { lastClock: `${await yhub.stream.getTime()}-1`, ...encodeDocForStore(ydoc) })
  t.assert((await yhub.persistence.retrieveDoc(defaultDocRef, { gc: true })).gcDoc.length === 1, 'a soft deletion still stores')
}

/**
 * @param {t.TestCase} tc
 */
export const testRetentionSweep = async tc => {
  const { createWsClient, yhub, defaultDocRef, org } = await utils.createTestCase(tc)
  const { ydoc } = await createWsClient({ waitForSync: true })
  ydoc.get().setAttr('a', 1)
  await promise.wait(500)
  await utils.waitTasksProcessed(yhub)
  await yhub.deleteDoc(defaultDocRef)
  dropClients()
  // a soft deletion leaves the content in place, which is what a retention task later sweeps
  t.assert((await yhub.persistence.retrieveDoc(defaultDocRef, { gc: true })).gcDoc.length > 0, 'the content is still there')
  const due = (await yhub.getTombstones(org, { purged: false })).filter(d => d.docid === defaultDocRef.docid)
  t.assert(due.length === 1 && due[0].hard === false, 'the sweep finds it pending')
  for (const doc of due) await yhub.deleteDoc(doc, { hard: true })
  const swept = /** @type {import('../src/types.js').Tombstone} */ (await yhub.persistence.retrieveTombstone(defaultDocRef))
  t.assert(swept.hard && swept.purgedAt != null, 'the sweep hard-deleted and purged it')
  t.assert((await yhub.persistence.retrieveDoc(defaultDocRef, { gc: true })).gcDoc.length === 0, 'its rows are gone')
  t.assert((await yhub.getTombstones(org, { purged: false })).every(d => d.docid !== defaultDocRef.docid), 'and it is no longer pending')
}

/**
 * Tombstone is per branch, like every other docRef-keyed thing in the system.
 *
 * @param {t.TestCase} tc
 */
export const testDeleteIsBranchScoped = async tc => {
  const { createWsClient, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const docRefB2 = { ...defaultDocRef, branch: 'b2' }
  const main = await createWsClient({ waitForSync: true })
  const b2 = await createWsClient({ waitForSync: true, branch: 'b2' })
  main.ydoc.get().setAttr('a', 1)
  b2.ydoc.get().setAttr('b', 2)
  await promise.wait(500)
  await utils.waitTasksProcessed(yhub)
  await yhub.deleteDoc(defaultDocRef, { hard: true })
  t.assert((await yhub.getDoc(defaultDocRef, { gc: true })).tombstone != null, 'getDoc reports the deletion')
  t.assert(await yhub.persistence.retrieveTombstone(docRefB2) === null, 'the sibling branch was not deleted')
  const other = await yhub.getDoc(docRefB2, { gc: true })
  const check = new Y.Doc()
  Y.applyUpdate(check, other.gcDoc)
  t.assert(check.get().getAttr('b') === 2, 'the sibling branch kept its content')
}

/**
 * @param {t.TestCase} tc
 */
export const testDeletedRestApi = async tc => {
  const { createWsClient, yhub, defaultDocRef, org } = await utils.createTestCase(tc)
  const { ydoc } = await createWsClient({ waitForSync: true })
  ydoc.get().setAttr('a', 1)
  await promise.wait(500)
  await utils.waitTasksProcessed(yhub)
  const docPath = `/api/ydoc/v1/${org}/${defaultDocRef.docid}`
  const activityPath = `/api/activity/v1/${org}/${defaultDocRef.docid}`
  const changesetPath = `/api/changeset/v1/${org}/${defaultDocRef.docid}`
  t.assert((await yhubRequest(docPath)).status === 200, 'readable before the deletion')
  // warm the response cache with the exact requests repeated after the deletion below. A cache hit
  // never reaches getDoc, so serving these afterwards is precisely what deleteDoc's invalidation
  // prevents - and waitTasksProcessed (above) flushed the cache, so these really do populate it.
  t.assert((await yhubRequest(activityPath)).status === 200, 'activity answers before the deletion')
  t.assert((await yhubRequest(changesetPath)).status === 200, 'changeset answers before the deletion')
  const deleted = await yhubRequest(docPath, 'DELETE')
  t.assert(deleted.status === 200, 'DELETE answers 200')
  t.assert(deleted.body.hard === false && deleted.body.by === 'user1', 'rest deletes softly, attributed')
  const got = await yhubRequest(docPath)
  t.assert(got.status === 404 && got.body.code === 'doc-deleted', 'GET ydoc reports it as absent')
  // identical requests to the ones cached above - a stale 200 here means the cache outlived the
  // deletion
  const activity = await yhubRequest(activityPath)
  t.assert(activity.status === 404 && activity.body.code === 'doc-deleted', 'activity reports it as absent, not from cache')
  const changeset = await yhubRequest(changesetPath)
  t.assert(changeset.status === 404 && changeset.body.code === 'doc-deleted', 'changeset reports it as absent, not from cache')
  // an awareness-only PATCH never reads the document, so it needs its own gate
  const patched = await yhubPatch(docPath, { awareness: new Uint8Array([1, 2, 3]) })
  t.assert(patched.status === 404 && patched.body.code === 'doc-deleted', 'awareness-only PATCH is refused')
  // the 404 transcodes like any other error body when the caller asks for json
  const jsonErr = await fetch(`http://${utils.yhubHost}${activityPath}`, { headers: { Accept: 'application/json' } })
  t.assert(jsonErr.status === 404, 'json callers get the same status')
  t.assert(jsonErr.headers.get('content-type') === 'application/json', 'and a json body')
  t.compare(await jsonErr.json(), { error: 'Not Found', code: 'doc-deleted' })
  // a json-encoded PATCH body is coerced before the gate runs, and still refused
  const jsonPatch = await fetch(`http://${utils.yhubHost}${docPath}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ awareness: buffer.toBase64(new Uint8Array([1, 2, 3])) })
  })
  t.assert(jsonPatch.status === 404, 'a json PATCH on a deleted doc is refused')
  t.compare(await jsonPatch.json(), { error: 'Not Found', code: 'doc-deleted' })
  // the mutating endpoints refuse too - each checks the tombstone getDoc handed it
  const rolledBack = await yhubPost(`/api/rollback/v1/${org}/${defaultDocRef.docid}`, { from: 1 })
  t.assert(rolledBack.status === 404 && rolledBack.body.code === 'doc-deleted', 'rollback is refused')
  const pruned = await yhubPost(`/api/prune/v1/${org}/${defaultDocRef.docid}`, { from: 1 })
  t.assert(pruned.status === 404 && pruned.body.code === 'doc-deleted', 'prune is refused')
  // idempotent, and a retry must not move the deletion timestamp
  const again = await yhubRequest(docPath, 'DELETE')
  t.assert(again.status === 200 && again.body.deletedAt === deleted.body.deletedAt, 'the deletion timestamp is stable')
}

/**
 * @param {t.TestCase} tc
 */
export const testWsKickOnDelete = async tc => {
  const { createWsClient, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const { provider } = await createWsClient({ waitForSync: true })
  /**
   * @type {Array<number>}
   */
  const closeCodes = []
  provider.on('connection-close', event => { event && closeCodes.push(event.code) })
  await yhub.deleteDoc(defaultDocRef)
  await promise.until(5000, () => closeCodes.includes(wsCloseDocDeleted))
  t.assert(closeCodes.includes(wsCloseDocDeleted), 'the client was closed with the deleted close code')
  dropClients()
  // and a connection opened afterwards is refused at initial sync, which is what keeps a deleted
  // document unreachable however a client comes back. Asserted on a fresh connection rather than
  // on @y/websocket's reconnect, so it does not depend on the provider's backoff timing.
  const fresh = createWsClient()
  /**
   * @type {Array<number>}
   */
  const freshCodes = []
  fresh.provider.on('connection-close', event => { event && freshCodes.push(event.code) })
  await promise.until(5000, () => freshCodes.includes(wsCloseDocDeleted))
  t.assert(freshCodes.includes(wsCloseDocDeleted), 'a new connection is refused with the same code')
  dropClients()
}

/**
 * A hard deletion clears the stream rather than deleting the key, so the kick that follows keeps
 * a strictly increasing id and reaches the clients that were writing in that same millisecond.
 * The worker then trims what is left and drops the key.
 *
 * @param {t.TestCase} tc
 */
export const testHardDeleteClearsStream = async tc => {
  const { createWsClient, yhub, defaultDocRef, defaultStream } = await utils.createTestCase(tc)
  const { ydoc } = await createWsClient({ waitForSync: true })
  ydoc.get().setAttr('a', 1)
  await promise.wait(500)
  const lastClockBefore = (await yhub.stream.getMessages([{ docRef: defaultDocRef, clock: '0' }]))[0].lastClock
  await yhub.deleteDoc(defaultDocRef, { hard: true })
  const [entry] = await yhub.stream.getMessages([{ docRef: defaultDocRef, clock: '0' }])
  t.assert(entry.messages.length === 1 && entry.messages[0].type === 'ydoc:tombstone:v1', 'only the kick is left')
  t.assert(isSmallerRedisClock(lastClockBefore, entry.lastClock), 'the kick sorts after everything before it')
  dropClients()
  const deletedAt = Date.now()
  await utils.waitTasksProcessed(yhub)
  t.assert(await yhub.stream.redis.exists(defaultStream) === 0, 'the stream was trimmed away')
  // and in one worker pass rather than after the tombstone ages out: under age-based trimming the
  // key could not go before minMessageLifetime had elapsed, so this bound is what distinguishes them
  t.assert(Date.now() - deletedAt < yhub.stream.minMessageLifetime, 'the stream drained in one pass')
  t.assert((await yhub.persistence.retrieveDoc(defaultDocRef, { gc: true })).gcDoc.length === 0, 'the worker persisted nothing')
}

/**
 * @param {t.TestCase} tc
 */
export const testGetDeletedDocs = async tc => {
  const { yhub, defaultDocRef, org } = await utils.createTestCase(tc)
  const docRefB2 = { ...defaultDocRef, branch: 'b2' }
  await yhub.deleteDoc(defaultDocRef)
  await yhub.deleteDoc(docRefB2, { hard: true })
  const pending = await yhub.getTombstones(org, { purged: false })
  t.assert(pending.every(d => d.purgedAt === null), 'pending deletions still hold their content')
  t.assert(pending.some(d => d.docid === defaultDocRef.docid && d.branch === 'main'), 'the soft deletion is pending')
  t.assert(!pending.some(d => d.docid === defaultDocRef.docid && d.branch === 'b2'), 'the hard deletion was purged already')
  const all = await yhub.getTombstones(org)
  t.assert(all.filter(d => d.docid === defaultDocRef.docid).length === 2, 'both branches are listed')
}

/**
 * The test hub's s3 plugin is configured with `branches: ['main']`, so a branch's assets live inline
 * in postgres.
 * The purge has no external object to delete for those, and the reference markers let it leave the
 * blobs where they are - while still deleting every row, which is the trap: rows are dropped by the
 * assetIds `deleteReferences` is handed, so an all-inline row that contributed none would survive.
 *
 * @param {t.TestCase} tc
 */
export const testInlineAssetsPurgeWithoutFetching = async tc => {
  const { yhub, defaultDocRef } = await utils.createTestCase(tc)
  const docRef = { ...defaultDocRef, branch: 'b2' }
  const ydoc = new Y.Doc()
  ydoc.get().setAttr('a', 1)
  await yhub.persistence.store(docRef, { lastClock: `${await yhub.stream.getTime()}-0`, ...encodeDocForStore(ydoc) })
  const all = { gc: true, nongc: true, contentmap: true, contentids: true }
  const marked = await yhub.persistence.sql`
    SELECT gcdoc_is_reference AS a, nongcdoc_is_reference AS b, contentmap_is_reference AS c, contentids_is_reference AS d
    FROM yhub_ydoc_v1 WHERE org = ${docRef.org} AND docid = ${docRef.docid} AND branch = ${docRef.branch}`
  t.assert(marked.every(r => !r.a && !r.b && !r.c && !r.d), 'inline assets are marked as data, not references')
  const { assets } = await yhub.persistence.retrieveAssets(docRef, all, { onlyReferences: true })
  t.assert(assets.length === 4, 'every column still yields an entry - that is what names the row')
  t.assert(assets.every(a => a.asset === null), 'and none of their bytes were fetched')
  // the resolved path still sees the content
  t.assert((await yhub.persistence.retrieveAssets(docRef, all)).assets.every(a => a.asset != null), 'the content path is unaffected')
  await yhub.deleteDoc(docRef, { hard: true })
  t.assert((await yhub.persistence.retrieveDoc(docRef, { gc: true })).gcDoc.length === 0, 'the all-inline rows are gone')
}

/**
 * Rows written before the markers existed default to `true` - "this may be a reference" - which
 * makes the purge fetch and check, exactly as it did before. This is the case a backfill would
 * otherwise be needed for.
 *
 * @param {t.TestCase} tc
 */
export const testPreMigrationRowsPurge = async tc => {
  const { yhub, defaultDocRef } = await utils.createTestCase(tc)
  const docRef = { ...defaultDocRef, branch: 'b2' }
  const ydoc = new Y.Doc()
  ydoc.get().setAttr('a', 1)
  await yhub.persistence.store(docRef, { lastClock: `${await yhub.stream.getTime()}-0`, ...encodeDocForStore(ydoc) })
  // what an ALTER-added column looks like on a row that predates it
  await yhub.persistence.sql`
    UPDATE yhub_ydoc_v1 SET gcdoc_is_reference = true, nongcdoc_is_reference = true,
      contentmap_is_reference = true, contentids_is_reference = true
    WHERE org = ${docRef.org} AND docid = ${docRef.docid} AND branch = ${docRef.branch}`
  const { assets } = await yhub.persistence.retrieveAssets(docRef, { gc: true, nongc: true, contentmap: true, contentids: true }, { onlyReferences: true })
  t.assert(assets.every(a => a.asset != null), 'the default makes them fetched and checked')
  await yhub.deleteDoc(docRef, { hard: true })
  t.assert((await yhub.persistence.retrieveDoc(docRef, { gc: true })).gcDoc.length === 0, 'and they still purge')
}

/**
 * A version whose object vanished out of band used to strand its row forever: references were only
 * collected for assets that still resolved, so neither compaction nor the purge could see it.
 *
 * @param {t.TestCase} tc
 */
export const testMissingObjectRowIsPurged = async tc => {
  const { createWsClient, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const { ydoc } = await createWsClient({ waitForSync: true })
  ydoc.get().setAttr('a', 1)
  await promise.wait(500)
  await utils.waitTasksProcessed(yhub)
  const names = await listS3Objects(yhub, defaultDocRef)
  t.assert(names.length > 0, 's3 objects exist')
  const s3 = /** @type {any} */ (yhub.conf.persistence[0])
  await s3.s3client.removeObjects(s3.bucket, names)
  t.assert((await listS3Objects(yhub, defaultDocRef)).length === 0, 'their objects are gone behind our back')
  dropClients()
  await yhub.deleteDoc(defaultDocRef, { hard: true })
  t.assert((await yhub.persistence.retrieveDoc(defaultDocRef, { gc: true })).gcDoc.length === 0, 'the rows are cleaned up anyway')
}
