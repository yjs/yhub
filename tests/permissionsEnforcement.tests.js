import * as Y from '@y/y'
import * as t from 'lib0/testing'
import * as buffer from 'lib0/buffer'
import * as promise from 'lib0/promise'
import * as types from '../src/types.js'
import * as utils from './utils.js'
import { checkPermissions, createDocumentPermissions, wsCloseAuthRevoked } from '../src/index.js'

/**
 * End-to-end enforcement of the permission facets (proposals/permissions.md §9): per-facet ws
 * gates, the recheck comparison, the rest facet gates of the built-in endpoints, the history-ray
 * clamp, and the endpoint facet at every scope. The merge/normalization algebra itself is
 * unit-tested in permissions.tests.js.
 */

const enfPort = utils.testHubPort(9)
const enfHost = `localhost:${enfPort}`

/**
 * Mutable fail-closed permission table: userid -> per-scope answer, anonymous callers under
 * `'anonymous'`. An unlisted user/scope is denied (`null` answer); `'throw'` makes the plugin fail
 * for that user. Each test resets the table up front (see auth.tests.js for the rationale) and
 * seeds exactly the grants it needs.
 *
 * @type {{ [userid: string]: { [scope: string]: any } }}
 */
const permTable = {}
const resetPermTable = () => { for (const userid in permTable) delete permTable[userid] }

await utils.createTestHub({
  worker: null,
  server: {
    port: enfPort,
    auth: types.createAuthPlugin({
      async authenticate (req) {
        // no `?user` / `x-user`: an anonymous caller
        const userid = req.getQuery('user') || req.getHeader('x-user') || null
        return userid === null ? null : { userid }
      },
      // deliberately hand-rolled (not createAuthorize): exercises the raw dispatch form - the
      // any-typed table satisfies the forced signature without a cast
      async authorize (scope, _resourceId, user) {
        const entry = permTable[user?.userid ?? 'anonymous']?.[scope]
        if (entry === 'throw') throw new Error('permission backend down')
        return entry === undefined ? null : entry
      }
    }),
    api: [
      { name: 'gated', get: { handler: async () => ({ ok: 1 }) }, post: { handler: async () => ({ ok: 1 }) } },
      // demonstrates handler-side facet validation - the framework checks only the endpoint facet
      {
        name: 'selfcheck',
        get: {
          handler: async req => {
            checkPermissions(req.permissions, createDocumentPermissions({ ydoc: '-r--' }))
            return { ok: 1 }
          }
        }
      },
      { name: 'orgstats', scope: 'org', get: { handler: async () => ({ ok: 1 }) } },
      { name: 'sysinfo', scope: 'global', get: { handler: async () => ({ ok: 1 }) } },
      // a route whose name collides with Object.prototype - the endpoint facet must still gate it
      // (regression: the containment compare must not dispatch on `.constructor`)
      { name: 'constructor', get: { handler: async () => ({ ok: 1 }) } }
    ]
  }
})

const enfWsUrl = utils.wsUrlFromPort(enfPort)

/**
 * @param {Partial<import('../src/permissions.js').DocumentPermissionsV1>} facets
 * @return {import('../src/permissions.js').DocumentPermissionsV1}
 */
const docPerms = facets => /** @type {any} */ ({ type: 'permissions:document:v1', ...facets })

/**
 * @param {string} path - below the api prefix, e.g. '/ydoc/v1/testOrg/mydoc'
 * @param {string} user
 * @param {RequestInit} [init]
 */
const enfFetch = (path, user, init = {}) => fetch(`http://${enfHost}/api${path}`, { ...init, headers: { 'x-user': user, ...(/** @type {any} */ (init.headers ?? {})) } })

/**
 * @param {Response} response
 */
const decodeResponse = async response => buffer.decodeAny(new Uint8Array(await response.arrayBuffer()))

/**
 * @param {import('@y/websocket').WebsocketProvider} provider
 * @param {Array<number>} closeCodes
 */
const recordCloseCodes = (provider, closeCodes) => {
  provider.on('connection-close', event => { event && closeCodes.push(event.code) })
}

/**
 * A read-only connection with awareness `u` broadcasts presence (the deliberate behavior change
 * of the permission system - the old blanket write gate swallowed it), while its doc edits stay
 * dropped, without closing the connection.
 *
 * @param {t.TestCase} tc
 */
export const testWsReadOnlyBroadcastsAwareness = async tc => {
  resetPermTable()
  permTable.writer = { document: docPerms({ ydoc: 'cru-', awareness: '-ru-', history: { from: 0 } }) }
  permTable.viewer = { document: docPerms({ ydoc: '-r--', awareness: '-ru-', history: { from: 0 } }) }
  const { createWsClient } = await utils.createTestCase(tc)
  const writer = await createWsClient({ waitForSync: true, wsUrl: enfWsUrl, wsParams: { user: 'writer' } })
  writer.ydoc.get().setAttr('a', 42)
  const viewer = await createWsClient({ waitForSync: true, wsUrl: enfWsUrl, wsParams: { user: 'viewer' } })
  t.assert(viewer.ydoc.get().getAttr('a') === 42, 'the viewer syncs')
  viewer.provider.awareness.setLocalStateField('user', { name: 'viewer' })
  await promise.until(5000, () => [...writer.provider.awareness.getStates().values()].some(state => state?.user?.name === 'viewer'))
  viewer.ydoc.get().setAttr('hidden', '!')
  await promise.wait(800)
  t.assert(writer.ydoc.get().getAttr('hidden') == null, 'viewer doc edits are dropped server-side')
  t.assert(viewer.provider.wsconnected, 'a dropped write does not close the connection')
}

/**
 * The two ws message gates are independent: a doc writer without awareness `u` cannot announce
 * presence, and awareness `u` without `r` announces without receiving (initial awareness send
 * and relay are both gated on `r`).
 *
 * @param {t.TestCase} tc
 */
export const testWsAwarenessGates = async tc => {
  resetPermTable()
  permTable.bob = { document: docPerms({ ydoc: 'cru-', awareness: '-ru-', history: { from: 0 } }) }
  permTable.carol = { document: docPerms({ ydoc: 'cru-', awareness: '-r--', history: { from: 0 } }) }
  permTable.dave = { document: docPerms({ ydoc: '-r--', awareness: '--u-', history: { from: 0 } }) }
  const { createWsClient } = await utils.createTestCase(tc)
  const bob = await createWsClient({ waitForSync: true, wsUrl: enfWsUrl, wsParams: { user: 'bob' } })
  bob.provider.awareness.setLocalStateField('user', { name: 'bob' })
  const carol = await createWsClient({ waitForSync: true, wsUrl: enfWsUrl, wsParams: { user: 'carol' } })
  await t.groupAsync('doc updates flow without awareness broadcast', async () => {
    carol.ydoc.get().setAttr('c', 1)
    await promise.until(5000, () => bob.ydoc.get().getAttr('c') === 1)
    carol.provider.awareness.setLocalStateField('user', { name: 'carol' })
    await promise.wait(800)
    t.assert(![...bob.provider.awareness.getStates().values()].some(state => state?.user?.name === 'carol'), "carol's presence is dropped without awareness 'u'")
    t.assert([...carol.provider.awareness.getStates().values()].some(state => state?.user?.name === 'bob'), "carol still receives bob's presence")
  })
  await t.groupAsync('announce without receiving', async () => {
    const dave = await createWsClient({ waitForSync: true, wsUrl: enfWsUrl, wsParams: { user: 'dave' } })
    dave.provider.awareness.setLocalStateField('user', { name: 'dave' })
    await promise.until(5000, () => [...bob.provider.awareness.getStates().values()].some(state => state?.user?.name === 'dave'))
    t.assert(dave.provider.awareness.getStates().size === 1, "dave never receives presence without awareness 'r'")
  })
}

/**
 * Upgrade refusals: no grant, a grant without ydoc read, and `gc=false` without full history
 * (§9.2 - the nongc doc is the full history, so a bounded ray refuses instead of silently
 * downgrading).
 *
 * @param {t.TestCase} tc
 */
export const testWsUpgradeRefusals = async tc => {
  resetPermTable()
  permTable.writer = { document: docPerms({ ydoc: 'cru-', awareness: '-ru-', history: { from: 0 } }) }
  permTable.writeonly = { document: docPerms({ ydoc: '--u-', history: { from: 0 } }) }
  permTable.bounded = { document: docPerms({ ydoc: 'cru-', history: { from: 5 } }) }
  permTable.full = { document: docPerms({ ydoc: '-r--', history: { from: 0 } }) }
  const { createWsClient } = await utils.createTestCase(tc)
  const writer = await createWsClient({ waitForSync: true, wsUrl: enfWsUrl, wsParams: { user: 'writer' } })
  writer.ydoc.get().setAttr('a', 42)
  await promise.wait(300)
  const refused = async (/** @type {{ [key: string]: any }} */ params) => {
    const client = createWsClient({ wsUrl: enfWsUrl, ...params })
    await promise.wait(1000)
    t.assert(client.ydoc.get().getAttr('a') == null, 'the refused connection must not sync')
  }
  await refused({ wsParams: { user: 'nobody' } })
  await refused({ wsParams: { user: 'writeonly' } })
  await refused({ gc: false, wsParams: { user: 'bounded' } })
  // the same bounded ray syncs on a gc=true connection, and full history syncs on gc=false
  await createWsClient({ waitForSync: true, wsUrl: enfWsUrl, wsParams: { user: 'bounded' } })
  await createWsClient({ waitForSync: true, gc: false, wsUrl: enfWsUrl, wsParams: { user: 'full' } })
}

/**
 * The recheck compares only the leaves the socket consumes (§9.6): REST-only facet changes
 * (delete/rollback/endpoint - and, on gc=true connections, the history ray) never bounce a live
 * connection; a changed ydoc or awareness mask closes 4401 (upgrades included); a failing
 * plugin closes 1013.
 *
 * @param {t.TestCase} tc
 */
export const testWsRecheckComparesWsLeaves = async tc => {
  resetPermTable()
  permTable.eve = { document: docPerms({ ydoc: 'cru-', awareness: '-ru-', history: { from: 0, rollback: true }, delete: ['soft', 'hard'], endpoint: { '*': 'crud' } }) }
  const { createWsClient, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const eve = await createWsClient({ waitForSync: true, wsUrl: enfWsUrl, wsParams: { user: 'eve' } })
  /** @type {Array<number>} */
  const closeCodes = []
  recordCloseCodes(eve.provider, closeCodes)
  await t.groupAsync('rest-only facet changes do not bounce the connection', async () => {
    permTable.eve = { document: docPerms({ ydoc: 'cru-', awareness: '-ru-', history: { from: 5 } }) }
    await yhub.recheckAuth(defaultDocRef, { users: ['eve'] })
    await promise.wait(800)
    t.assert(eve.provider.wsconnected && closeCodes.length === 0, 'delete/rollback/endpoint/bounded-ray changes are invisible to a gc=true socket')
  })
  await t.groupAsync('a changed awareness mask bounces 4401', async () => {
    permTable.eve = { document: docPerms({ ydoc: 'cru-', awareness: '-r--', history: { from: 5 } }) }
    await yhub.recheckAuth(defaultDocRef, { users: ['eve'] })
    await promise.until(5000, () => closeCodes.includes(wsCloseAuthRevoked))
  })
  await t.groupAsync('a ydoc mask upgrade bounces 4401 too', async () => {
    await promise.until(5000, () => eve.provider.wsconnected)
    closeCodes.length = 0
    permTable.eve = { document: docPerms({ ydoc: 'crud', awareness: '-r--', history: { from: 5 } }) }
    await yhub.recheckAuth(defaultDocRef, { users: ['eve'] })
    await promise.until(5000, () => closeCodes.includes(wsCloseAuthRevoked))
  })
  await t.groupAsync('a failing plugin closes 1013, never 4401', async () => {
    await promise.until(5000, () => eve.provider.wsconnected)
    closeCodes.length = 0
    permTable.eve = { document: 'throw' }
    await yhub.recheckAuth(defaultDocRef, { users: ['eve'] })
    await promise.until(5000, () => closeCodes.includes(1013))
    t.assert(!closeCodes.includes(wsCloseAuthRevoked))
    permTable.eve = { document: docPerms({ ydoc: 'crud', awareness: '-r--', history: { from: 5 } }) }
    await promise.until(5000, () => eve.provider.wsconnected)
  })
}

/**
 * A `gc=false` connection carries the full-history requirement in its recheck comparison: the
 * ray leaving 0 revokes it (§9.2 + §9.6).
 *
 * @param {t.TestCase} tc
 */
export const testWsRecheckFullHistoryBit = async tc => {
  resetPermTable()
  permTable.hist = { document: docPerms({ ydoc: 'cru-', history: { from: 0 } }) }
  const { createWsClient, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const hist = await createWsClient({ waitForSync: true, gc: false, wsUrl: enfWsUrl, wsParams: { user: 'hist' } })
  /** @type {Array<number>} */
  const closeCodes = []
  recordCloseCodes(hist.provider, closeCodes)
  permTable.hist = { document: docPerms({ ydoc: 'cru-', history: { from: 5 } }) }
  await yhub.recheckAuth(defaultDocRef, { users: ['hist'] })
  await promise.until(5000, () => closeCodes.includes(wsCloseAuthRevoked))
}

/**
 * The facet gates of GET/PATCH/DELETE /ydoc, including the missing-permission 403 body and its
 * json transcode, and the unknown-type-version denial.
 *
 * @param {t.TestCase} tc
 */
export const testRestYdocFacetGates = async tc => {
  resetPermTable()
  permTable.reader = { document: docPerms({ ydoc: '-r--', endpoint: { '*': 'crud' } }) }
  permTable.observer = { document: docPerms({ ydoc: '-r--', awareness: '-r--', history: { from: 0 }, endpoint: { '*': 'crud' } }) }
  permTable.writer = { document: docPerms({ ydoc: 'cru-', endpoint: { '*': 'crud' } }) }
  permTable.presence = { document: docPerms({ awareness: '--u-', endpoint: { '*': 'crud' } }) }
  permTable.futuristic = { document: { type: 'permissions:document:v2', ydoc: 'crud' } }
  const { org } = await utils.createTestCase(tc)
  const doc = `/ydoc/v1/${org}/${tc.testName}-doc`
  await t.groupAsync('read facet + missing-permission body', async () => {
    t.assert((await enfFetch(doc, 'reader')).status === 200)
    const denied = await enfFetch(doc, 'nobody')
    t.assert(denied.status === 403)
    const body = await decodeResponse(denied)
    t.assert(body.code === 'missing-permission')
    // the fully-denied subject fails at the endpoint gate, before any handler runs
    t.compare(body.required, docPerms({ endpoint: { ydoc: '-r--' } }))
    // the body transcodes to json on request
    const deniedJson = await enfFetch(doc, 'nobody', { headers: { accept: 'application/json' } })
    t.assert(deniedJson.status === 403 && (await deniedJson.json()).code === 'missing-permission')
  })
  await t.groupAsync('awareness and gc=false facets on GET', async () => {
    const noAwareness = await enfFetch(`${doc}?awareness=true`, 'reader')
    t.assert(noAwareness.status === 403)
    // `required` carries the handler's whole fragment - the one checkPermissions call decides it
    t.compare((await decodeResponse(noAwareness)).required, docPerms({ ydoc: '-r--', awareness: '-r--' }))
    t.assert((await enfFetch(`${doc}?awareness=true`, 'observer')).status === 200)
    const noHistory = await enfFetch(`${doc}?gc=false`, 'reader')
    t.assert(noHistory.status === 403)
    t.compare((await decodeResponse(noHistory)).required, docPerms({ ydoc: '-r--', history: { from: 0 } }))
    t.assert((await enfFetch(`${doc}?gc=false`, 'observer')).status === 200)
  })
  await t.groupAsync('PATCH gates per leaf', async () => {
    const update = new Y.Doc()
    update.get().setAttr('x', 1)
    const patchBody = (/** @type {object} */ body) => /** @type {RequestInit} */ ({ method: 'PATCH', headers: { 'content-type': 'application/octet-stream' }, body: /** @type {Uint8Array<ArrayBuffer>} */ (buffer.encodeAny(body)) })
    t.assert((await enfFetch(doc, 'reader', patchBody({ update: Y.encodeStateAsUpdate(update) }))).status === 403)
    t.assert((await enfFetch(doc, 'writer', patchBody({ update: Y.encodeStateAsUpdate(update) }))).status === 200)
    // an awareness-only body passes on awareness 'u' alone - no ydoc access needed
    t.assert((await enfFetch(doc, 'presence', patchBody({ awareness: new Uint8Array([0]) }))).status === 200)
    t.assert((await enfFetch(doc, 'reader', patchBody({ awareness: new Uint8Array([0]) }))).status === 403)
  })
  await t.groupAsync('an unknown future type version denies instead of throwing', async () => {
    t.assert((await enfFetch(doc, 'futuristic')).status === 403)
  })
  await t.groupAsync('DELETE requires the delete facet by kind', async () => {
    permTable.softie = { document: docPerms({ ydoc: 'crud', delete: ['soft'], endpoint: { '*': 'crud' } }) }
    permTable.eraser = { document: docPerms({ delete: ['hard', 'soft'], endpoint: { '*': 'crud' } }) }
    const delDoc = (/** @type {string} */ name) => `/ydoc/v1/${org}/${tc.testName}-${name}`
    // a full write mask alone never implies deletion
    t.assert((await enfFetch(delDoc('a'), 'writer', { method: 'DELETE' })).status === 403)
    const softRes = await enfFetch(delDoc('a'), 'softie', { method: 'DELETE' })
    t.assert(softRes.status === 200 && (await decodeResponse(softRes)).hard === false)
    const hardDenied = await enfFetch(`${delDoc('b')}?hard=true`, 'softie', { method: 'DELETE' })
    t.assert(hardDenied.status === 403)
    t.compare((await decodeResponse(hardDenied)).required, docPerms({ delete: ['hard'] }))
    const hardRes = await enfFetch(`${delDoc('b')}?hard=true`, 'eraser', { method: 'DELETE' })
    t.assert(hardRes.status === 200 && (await decodeResponse(hardRes)).hard === true)
  })
}

/**
 * Multiplex atomicity (§9.4): a PATCH carrying update + awareness with permission for only one
 * of them fails whole - nothing is applied before the failing check.
 *
 * @param {t.TestCase} tc
 */
export const testRestPatchAtomicity = async tc => {
  resetPermTable()
  permTable.half = { document: docPerms({ ydoc: 'cru-', awareness: false, endpoint: { '*': 'crud' } }) }
  permTable.full = { document: docPerms({ ydoc: '-r--', awareness: '-r--', endpoint: { '*': 'crud' } }) }
  const { org } = await utils.createTestCase(tc)
  const doc = `/ydoc/v1/${org}/${tc.testName}-doc`
  const update = new Y.Doc()
  update.get().setAttr('leaked', true)
  const res = await enfFetch(doc, 'half', { method: 'PATCH', headers: { 'content-type': 'application/octet-stream' }, body: /** @type {Uint8Array<ArrayBuffer>} */ (buffer.encodeAny({ update: Y.encodeStateAsUpdate(update), awareness: new Uint8Array([0]) })) })
  t.assert(res.status === 403)
  const after = await decodeResponse(await enfFetch(`${doc}?awareness=true`, 'full'))
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, after.doc)
  t.assert(ydoc.get().getAttr('leaked') == null, 'the update leg was not applied')
  t.assert(after.awareness == null, 'the awareness leg was not applied')
}

/**
 * Rollback/prune containment (§9.3): the named boolean is required, and mutations refuse -
 * never clamp - when the requested range starts before the granted ray. Filter-only bodies have
 * an unbounded range.
 *
 * @param {t.TestCase} tc
 */
export const testRollbackPruneRayContainment = async tc => {
  resetPermTable()
  permTable.writer = { document: docPerms({ ydoc: 'cru-', awareness: '-ru-', history: { from: 0, rollback: true, prune: true }, endpoint: { '*': 'crud' } }) }
  const { org, createWsClient } = await utils.createTestCase(tc)
  const writer = await createWsClient({ waitForSync: true, wsUrl: enfWsUrl, wsParams: { user: 'writer' } })
  writer.ydoc.get().setAttr('early', 1)
  await promise.wait(1200)
  const mid = Date.now()
  writer.ydoc.get().setAttr('late', 2)
  await promise.wait(300)
  permTable.bounded = { document: docPerms({ ydoc: 'cru-', history: { from: mid, rollback: true, prune: true }, endpoint: { '*': 'crud' } }) }
  permTable.nameless = { document: docPerms({ ydoc: 'cru-', history: { from: 0 }, endpoint: { '*': 'crud' } }) }
  const post = (/** @type {string} */ endpoint, /** @type {object} */ body) => (/** @type {string} */ user) =>
    enfFetch(`/${endpoint}/v1/${org}/${tc.testName}-index`, user, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  await t.groupAsync('the boolean is required despite write access', async () => {
    t.assert((await post('rollback', { from: mid })('nameless')).status === 403)
    t.assert((await post('prune', { from: mid })('nameless')).status === 403)
  })
  await t.groupAsync('a bounded ray refuses ranges before it and filter-only bodies', async () => {
    t.assert((await post('rollback', { from: mid - 100000 })('bounded')).status === 403)
    const filterOnly = await post('rollback', { by: 'writer' })('bounded')
    t.assert(filterOnly.status === 403)
    t.assert((await decodeResponse(filterOnly)).code === 'missing-permission')
    t.assert((await post('prune', { from: mid - 100000 })('bounded')).status === 403)
  })
  await t.groupAsync('contained and full-ray requests pass', async () => {
    t.assert((await post('prune', { from: mid })('bounded')).status === 200)
    t.assert((await post('rollback', { from: mid })('bounded')).status === 200)
    t.assert((await post('rollback', { by: 'writer' })('writer')).status === 200)
  })
}

/**
 * History-ray clamping happens before the cache key (§9.1) - a bounded reader can never poison
 * the cache for a full reader or vice versa - `history: false` refuses before any cache read,
 * and the rendered-content flags (`?ydoc=`/`?delta=`) require ydoc read (§9.7): a history-only
 * grant must not reconstruct document content.
 *
 * @param {t.TestCase} tc
 */
export const testHistoryClampAndContentLeak = async tc => {
  resetPermTable()
  permTable.writer = { document: docPerms({ ydoc: 'cru-', awareness: '-ru-', history: { from: 0 } }) }
  const { org, createWsClient } = await utils.createTestCase(tc)
  const writer = await createWsClient({ waitForSync: true, wsUrl: enfWsUrl, wsParams: { user: 'writer' } })
  writer.ydoc.get().setAttr('early', 1)
  await promise.wait(1500)
  const mid = Date.now()
  writer.ydoc.get().setAttr('late', 2)
  await promise.wait(500)
  permTable.auditor = { document: docPerms({ history: { from: mid }, endpoint: { '*': 'crud' } }) }
  permTable.historian = { document: docPerms({ ydoc: '-r--', history: { from: 0 }, endpoint: { '*': 'crud' } }) }
  permTable.blind = { document: docPerms({ ydoc: '-r--', endpoint: { '*': 'crud' } }) }
  const activity = `/activity/v1/${org}/${tc.testName}-index?group=false`
  await t.groupAsync('bounded first: the clamped key must not be served to the full reader', async () => {
    const bounded = await decodeResponse(await enfFetch(activity, 'auditor'))
    t.assert(bounded.activity.length === 1 && bounded.activity.every((/** @type {any} */ e) => e.from >= mid), 'the ray clamps the visible history')
    const full = await decodeResponse(await enfFetch(activity, 'historian'))
    t.assert(full.activity.length === 2, 'the full reader sees everything despite the warmed cache')
  })
  await t.groupAsync('full first: the full key must not be served to the bounded reader', async () => {
    const changeset = `/changeset/v1/${org}/${tc.testName}-index?attributions=true`
    const full = new Uint8Array(await (await enfFetch(changeset, 'historian')).arrayBuffer())
    const bounded = new Uint8Array(await (await enfFetch(changeset, 'auditor')).arrayBuffer())
    t.assert(buffer.toBase64(full) !== buffer.toBase64(bounded), 'the bounded reader computes its own clamped response')
  })
  await t.groupAsync('history: false refuses before any cache read', async () => {
    t.assert((await enfFetch(activity, 'blind')).status === 403)
    t.assert((await enfFetch(`/changeset/v1/${org}/${tc.testName}-index`, 'blind')).status === 403)
  })
  await t.groupAsync('rendered content requires ydoc read - the audit-only leak gate', async () => {
    const leak = await enfFetch(`${activity}&ydoc=true`, 'auditor')
    t.assert(leak.status === 403)
    // the requirement names the clamped `from` (the auditor's own ray start) - the auditor
    // satisfies that half, the ydoc-read half is what refuses
    t.compare((await decodeResponse(leak)).required, docPerms({ history: { from: mid }, ydoc: '-r--' }))
    t.assert((await enfFetch(`/changeset/v1/${org}/${tc.testName}-index?delta=true`, 'auditor')).status === 403)
    t.assert((await enfFetch(`${activity}&ydoc=true`, 'historian')).status === 200)
  })
}

/**
 * Anonymous callers (`authenticate` → null) are authorized like anyone else: reads, presence,
 * history and deletion work on a grant, and a missing grant is 403 - never 401. Writing the
 * document is the exception - attributions carry the userid - and it is refused with 401 only
 * *after* the permission check: an anonymous caller holding ydoc `u` gets 401 from PATCH/rollback
 * and at the ws upgrade, one without `u` gets the ordinary 403.
 *
 * @param {t.TestCase} tc
 */
export const testAnonymousAccess = async tc => {
  resetPermTable()
  permTable.writer = { document: docPerms({ ydoc: 'cru-', awareness: '-ru-', history: { from: 0, rollback: true }, endpoint: { '*': 'crud' } }) }
  const { org, createWsClient } = await utils.createTestCase(tc)
  const doc = `/ydoc/v1/${org}/${tc.testName}-index`
  const anonFetch = (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => fetch(`http://${enfHost}/api${path}`, init)
  const patchBody = (/** @type {object} */ body) => /** @type {RequestInit} */ ({ method: 'PATCH', headers: { 'content-type': 'application/octet-stream' }, body: /** @type {Uint8Array<ArrayBuffer>} */ (buffer.encodeAny(body)) })
  const update = new Y.Doc()
  update.get().setAttr('anon', true)
  const writer = await createWsClient({ waitForSync: true, wsUrl: enfWsUrl, wsParams: { user: 'writer' } })
  writer.ydoc.get().setAttr('a', 42)
  await promise.wait(300)
  await t.groupAsync('no grant: 403, never 401', async () => {
    const denied = await anonFetch(doc)
    t.assert(denied.status === 403)
    t.assert((await decodeResponse(denied)).code === 'missing-permission')
    const client = createWsClient({ wsUrl: enfWsUrl })
    await promise.wait(1000)
    t.assert(client.ydoc.get().getAttr('a') == null, 'the refused connection must not sync')
  })
  await t.groupAsync('a reader grant works anonymously', async () => {
    permTable.anonymous = { document: docPerms({ ydoc: '-r--', awareness: '-ru-', history: { from: 0 }, delete: ['soft'], endpoint: { '*': 'crud' } }) }
    t.assert((await anonFetch(doc)).status === 200)
    t.assert((await anonFetch(`/activity/v1/${org}/${tc.testName}-index`)).status === 200)
    t.assert((await anonFetch(doc, patchBody({ awareness: new Uint8Array([0]) }))).status === 200, 'presence needs no identity')
    const anon = await createWsClient({ waitForSync: true, wsUrl: enfWsUrl })
    t.assert(anon.ydoc.get().getAttr('a') === 42, 'the anonymous socket syncs')
    anon.provider.awareness.setLocalStateField('user', { name: 'anon' })
    await promise.until(5000, () => [...writer.provider.awareness.getStates().values()].some(state => state?.user?.name === 'anon'))
    // permission before identity: without `u` the write is the ordinary 403
    const noWrite = await anonFetch(doc, patchBody({ update: Y.encodeStateAsUpdate(update) }))
    t.assert(noWrite.status === 403)
    t.compare((await decodeResponse(noWrite)).required, docPerms({ ydoc: '--u-' }))
    const del = await anonFetch(`/ydoc/v1/${org}/${tc.testName}-deleted`, { method: 'DELETE' })
    t.assert(del.status === 200 && (await decodeResponse(del)).by === null)
  })
  await t.groupAsync('writing the document requires an identity', async () => {
    permTable.anonymous = { document: docPerms({ ydoc: 'cru-', awareness: '-ru-', history: { from: 0, rollback: true }, endpoint: { '*': 'crud' } }) }
    const patch = await anonFetch(doc, patchBody({ update: Y.encodeStateAsUpdate(update) }))
    t.assert(patch.status === 401)
    t.assert((await decodeResponse(patch)).code === 'unauthenticated')
    t.assert(writer.ydoc.get().getAttr('anon') == null, 'nothing was applied')
    const rollback = await anonFetch(`/rollback/v1/${org}/${tc.testName}-index`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: 'writer' }) })
    t.assert(rollback.status === 401)
    const client = createWsClient({ wsUrl: enfWsUrl })
    await promise.wait(1000)
    t.assert(client.ydoc.get().getAttr('a') == null, 'an anonymous socket may not hold ydoc u - the upgrade is refused')
    // the same grant with an identity writes
    permTable.named = permTable.anonymous
    t.assert((await fetch(`http://${enfHost}/api${doc}`, { ...patchBody({ update: Y.encodeStateAsUpdate(update) }), headers: { 'x-user': 'named', 'content-type': 'application/octet-stream' } })).status === 200)
    await promise.until(5000, () => writer.ydoc.get().getAttr('anon') === true)
  })
}

/**
 * The `endpoint` facet gates every rest endpoint - builtin and custom alike, at every scope -
 * before its handler runs; the semantic facets are the handler's business (builtins and
 * self-validating custom handlers check `req.permissions` themselves). An invalid or
 * wrong-scope-typed plugin answer is a loud 500, never a silent denial.
 *
 * @param {t.TestCase} tc
 */
export const testEndpointFacetAndHandlerChecks = async tc => {
  resetPermTable()
  const { org } = await utils.createTestCase(tc)
  await t.groupAsync('org and global grants', async () => {
    permTable.orgAdmin = { org: { type: 'permissions:org:v1', endpoint: { orgstats: '-r--' } } }
    permTable.sys = { global: { type: 'permissions:global:v1', endpoint: { '*': '-r--' } } }
    t.assert((await enfFetch(`/orgstats/v1/${org}`, 'orgAdmin')).status === 200)
    t.assert((await enfFetch(`/orgstats/v1/${org}`, 'nobody')).status === 403)
    t.assert((await enfFetch('/sysinfo/v1', 'sys')).status === 200)
    t.assert((await enfFetch('/sysinfo/v1', 'orgAdmin')).status === 403)
  })
  await t.groupAsync('an invalid or wrong-scope answer is a loud plugin bug', async () => {
    permTable.confused = { org: docPerms({ endpoint: { '*': 'crud' } }) }
    t.assert((await enfFetch(`/orgstats/v1/${org}`, 'confused')).status === 500)
    // schema validation of the answer: 'rw' is not a crud mask
    permTable.broken = { document: docPerms(/** @type {any} */ ({ ydoc: 'rw' })) }
    t.assert((await enfFetch(`/ydoc/v1/${org}/${tc.testName}-doc`, 'broken')).status === 500)
  })
  await t.groupAsync('the endpoint facet gates builtins and custom endpoints alike', async () => {
    permTable.ydocOnly = { document: docPerms({ ydoc: 'crud', history: { from: 0 } }) }
    const denied = await enfFetch(`/ydoc/v1/${org}/${tc.testName}-doc`, 'ydocOnly')
    t.assert(denied.status === 403)
    t.compare((await decodeResponse(denied)).required, docPerms({ endpoint: { ydoc: '-r--' } }))
    t.assert((await enfFetch(`/gated/v1/${org}/${tc.testName}-doc`, 'ydocOnly')).status === 403)
  })
  await t.groupAsync('a route named `constructor` gates like any other endpoint name', async () => {
    permTable.ctor = { document: docPerms(/** @type {any} */ ({ endpoint: { constructor: '-r--' } })) }
    permTable.other = { document: docPerms(/** @type {any} */ ({ endpoint: { '*': 'crud', constructor: false } })) }
    t.assert((await enfFetch(`/constructor/v1/${org}/${tc.testName}-doc`, 'ctor')).status === 200, 'a granted caller reaches it')
    const denied = await enfFetch(`/constructor/v1/${org}/${tc.testName}-doc`, 'other')
    t.assert(denied.status === 403, 'an explicit denial blocks it despite the crud fallback')
    const req = (await decodeResponse(denied)).required
    t.assert(req.endpoint.constructor === '-r--' && Object.keys(req.endpoint).length === 1)
  })
  await t.groupAsync('semantic facets are the handler business, not the framework', async () => {
    permTable.restless = { document: docPerms({ ydoc: '----', endpoint: { '*': 'crud' } }) }
    permTable.readerly = { document: docPerms({ ydoc: '-r--', endpoint: { '*': 'crud', gated: '-r--' } }) }
    const doc = `/v1/${org}/${tc.testName}-doc`
    // a handler that touches nothing runs on the endpoint grant alone, whatever the ydoc mask
    t.assert((await enfFetch(`/gated${doc}`, 'restless')).status === 200)
    // a handler that reads the document answers its own 403 from req.permissions
    const denied = await enfFetch(`/selfcheck${doc}`, 'restless')
    t.assert(denied.status === 403)
    t.compare((await decodeResponse(denied)).required, docPerms({ ydoc: '-r--' }))
    t.assert((await enfFetch(`/selfcheck${doc}`, 'readerly')).status === 200)
    // the endpoint facet still gates by verb class, named entries first
    t.assert((await enfFetch(`/gated${doc}`, 'readerly')).status === 200)
    const postDenied = await enfFetch(`/gated${doc}`, 'readerly', { method: 'POST' })
    t.assert(postDenied.status === 403, "post checks the 'c' position of the endpoint mask")
    t.compare((await decodeResponse(postDenied)).required, docPerms({ endpoint: { gated: 'c---' } }))
  })
}
