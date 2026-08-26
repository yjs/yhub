import * as t from 'lib0/testing'
import * as jwt from 'lib0/crypto/jwt'
import * as ecdsa from 'lib0/crypto/ecdsa'
import * as s from 'lib0/schema'
import * as p from '../src/permissions.js'
import * as types from '../src/types.js'
import * as utils from './utils.js'
import * as f from 'lib0/function'
import * as time from 'lib0/time'
import * as promise from 'lib0/promise'
import * as buffer from 'lib0/buffer'
import { apiError, wsCloseAuthRevoked } from '../src/index.js'
import { matchesAuthInfo } from '../src/server.js'

const authPrivateKey = await ecdsa.importKeyJwk({ key_ops: ['sign'], ext: true, kty: 'EC', x: '96pShK8Z3iJ8UZpN4tuyv9CuPuzwWgC_I72N6ZUNWOSBDflVxwYPtL3PcCgCF2aE', y: 'Q39u2jtATgoBd9D8Tx744v6KljwE3iOZr30Rf8yuVT3UgGEi0bcKufUGVSeKls8s', crv: 'P-384', d: 'BS_hqq6UMpuqS10oIWzEyTUt7RRQrysUMUdlwUyVimV_CTTNEpxXFW9_D0NA9rHt' })
const authPublicKey = await ecdsa.importKeyJwk({ key_ops: ['verify'], ext: true, kty: 'EC', x: '96pShK8Z3iJ8UZpN4tuyv9CuPuzwWgC_I72N6ZUNWOSBDflVxwYPtL3PcCgCF2aE', y: 'Q39u2jtATgoBd9D8Tx744v6KljwE3iOZr30Rf8yuVT3UgGEi0bcKufUGVSeKls8s', crv: 'P-384' })

const authHubPort = utils.testHubPort(1)

/**
 * This is an example of how you could add auth support via jwt.
 *
 * This server reads the auth information from the auth url-parameter.
 * Alternatively, the auth info could also be stored in the protocol information of the websockets
 * to hide the auth info from logging tools.
 */
await utils.createTestHub({
  worker: null,
  server: {
    port: authHubPort,
    auth: types.createAuthPlugin({
      async authenticate (req) {
        const authJwt = req.getQuery('auth')
        // no token: an anonymous caller (the document handler below answers it null)
        if (authJwt == null || authJwt.length === 0) return null
        let auth
        try {
          auth = await jwt.verifyJwt(authPublicKey, authJwt)
        } catch (_err) {
          // a presented credential that fails verification is rejected with a branded 401 - an
          // unbranded throw would be read as an auth-backend outage (503)
          throw apiError(401, 'invalid token')
        }
        const payload = s.$object({ docRefs: s.$array(s.$object({ docRef: types.$docRef, permissions: p.$documentPermissionsV1 })), userid: s.$string }).expect(auth.payload)
        // token payloads are external json - sanitize each permission object once, at this
        // boundary, so prototype-member endpoint names stay inert own keys downstream
        return { userid: payload.userid, docRefs: payload.docRefs.map(r => ({ docRef: r.docRef, permissions: /** @type {import('../src/permissions.js').DocumentPermissionsV1} */ (p.sanitizePermissions(r.permissions)) })) }
      },
      // capability-token pattern: the answer is a lookup in the sanitized claims - deterministic
      // per (type, resourceId, user), so the recheck contract holds trivially
      authorize: types.createAuthorize({
        /**
         * @param {types.DocRef} docRef
         * @param {{ userid: string, docRefs: Array<{ docRef: types.DocRef, permissions: import('../src/permissions.js').DocumentPermissionsV1 }> } | null} user
         */
        document: async (docRef, user) => user?.docRefs.find(r => f.equalityDeep(docRef, r.docRef))?.permissions ?? null
      })
    })
  }
})

/**
 * The documented migration mapping (permissions.md §12) of the retired AccessType onto document
 * permission objects - destructive facets deliberately excluded; the 'r' row grants only the
 * GET verb class on endpoints.
 *
 * @param {'r'|'rw'} accessType
 * @return {import('../src/permissions.js').DocumentPermissionsV1}
 */
const docPermissionsPreset = accessType => ({
  type: 'permissions:document:v1',
  ydoc: accessType === 'rw' ? 'cru-' : '-r--',
  awareness: '-ru-',
  history: { from: 0 },
  endpoint: { '*': accessType === 'rw' ? 'crud' : '-r--' }
})

const kickHubPort = utils.testHubPort(2)
/**
 * Mutable permission table: userid -> document permissions, so tests can revoke/downgrade access
 * of connected users. Unlisted users get the full 'rw' preset. `null` is a meaningful (revoked)
 * entry, hence the explicit `undefined` check. `'throw'` makes the plugin fail for that user;
 * `'throw503'` makes it fail with a branded `apiError(503, ...)`.
 *
 * @type {{ [userid: string]: import('../src/permissions.js').DocumentPermissionsV1 | null | 'throw' | 'throw503' }}
 */
const kickPerms = {}
// each recheckAuth test resets the table up front rather than cleaning up at its end - a thrown
// assert would otherwise leak a revoked entry into the next test, whose client then never syncs
// (endless 403 reconnect loop) and hangs the suite
const resetKickPerms = () => { for (const userid in kickPerms) delete kickPerms[userid] }
let kickPermChecks = 0
await utils.createTestHub({
  worker: null,
  server: {
    port: kickHubPort,
    auth: types.createAuthPlugin({
      async authenticate (req) {
        // the extra `group` property makes connection authInfos proper supersets of the
        // `{ userid }` matchers used in the recheckAuth tests
        return { userid: req.getQuery('user') ?? 'user1', group: 'g0' }
      },
      authorize: types.createAuthorize({
        document: async (_docRef, user) => {
          kickPermChecks++
          const entry = kickPerms[user.userid]
          if (entry === 'throw') throw new Error('auth backend down')
          if (entry === 'throw503') throw apiError(503, 'auth backend unavailable')
          return entry === undefined ? docPermissionsPreset('rw') : entry
        }
      })
    })
  }
})

/**
 * This is a function the server would use to create a jwt. Note that the private key must be kept
 * private. The authenticated client should only know about the jwt.
 *
 * @param {'r'|'rw'} [accessType]
 */
const createJwtAccessToken = async (accessType = 'rw') => {
  const token = await jwt.encodeJwt(authPrivateKey, {
    iss: 'yhub-demo',
    exp: time.getUnixTime() + 60 * 60 * 1000, // token expires in one hour
    userid: 'testUser', // associate the client with a unique id that can will be used to check permissions
    docRefs: [{ docRef: { org: 'testOrg', docid: 'testSampleAuthServer-index', branch: 'main' }, permissions: docPermissionsPreset(accessType) }]
  })
  return token
}

/**
 * @param {t.TestCase} tc
 */
export const testSampleAuthServer = async tc => {
  const myAuthToken = await createJwtAccessToken()
  const { createWsClient } = await utils.createTestCase(tc)
  const { ydoc: ydoc0 } = await createWsClient({ waitForSync: true })
  ydoc0.get().setAttr('a', 42)
  await promise.wait(500)
  const { ydoc: ydoc1 } = await createWsClient({ wsUrl: utils.wsUrlFromPort(authHubPort), waitForSync: true, wsParams: { auth: myAuthToken } })
  t.assert(ydoc1.get().getAttr('a') === 42)
  await t.groupAsync('should not sync if unauthenticated', async () => {
    const { ydoc: ydocUnauthenticated } = createWsClient({ wsUrl: utils.wsUrlFromPort(authHubPort) })
    await promise.wait(1000)
    t.assert(ydocUnauthenticated.get().getAttr('a') == null)
  })
  await t.groupAsync('should not publish updates from readonly users', async () => {
    const readonlyAuthToken = await createJwtAccessToken('r')
    const { ydoc: ydocReadonly } = createWsClient({ wsUrl: utils.wsUrlFromPort(authHubPort), wsParams: { auth: readonlyAuthToken } })
    ydocReadonly.get().setAttr('hidden', '!')
    await promise.wait(1000)
    t.assert(ydocReadonly.get().getAttr('a') != null)
    t.assert(ydoc1.get().getAttr('a') != null)
    t.assert(ydoc1.get().getAttr('hidden') == null)
    t.assert(ydocReadonly.get().getAttr('hidden') != null)
  })
}

/**
 * @param {t.TestCase} _tc
 */
export const testMatchesAuthInfo = _tc => {
  const authInfo = { userid: 'alice', group: 'g1', roles: ['editor', 'admin'] }
  t.assert(matchesAuthInfo('alice', authInfo), 'string matcher matches the userid')
  t.assert(!matchesAuthInfo('bob', authInfo))
  t.assert(matchesAuthInfo({ userid: 'alice' }, authInfo), 'subset match: authInfo may have additional properties')
  t.assert(matchesAuthInfo({ userid: 'alice', group: 'g1' }, authInfo))
  t.assert(matchesAuthInfo({ roles: ['editor', 'admin'] }, authInfo), 'properties are compared with deep equality')
  t.assert(!matchesAuthInfo({ roles: ['editor'] }, authInfo), 'a property must fully deep-equal, no recursive subset match')
  t.assert(!matchesAuthInfo({ userid: 'alice', team: 'x' }, authInfo), 'matcher property missing from authInfo')
  t.assert(matchesAuthInfo({}, authInfo), 'the empty matcher matches every authInfo')
}

/**
 * @param {import('@y/websocket').WebsocketProvider} provider
 * @param {Array<number>} closeCodes
 */
const recordCloseCodes = (provider, closeCodes) => {
  provider.on('connection-close', event => { event && closeCodes.push(event.code) })
}

/**
 * @param {t.TestCase} tc
 */
export const testRecheckAuthKicksRevokedUser = async tc => {
  resetKickPerms()
  const { createWsClient, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const wsUrl = utils.wsUrlFromPort(kickHubPort)
  const alice = await createWsClient({ waitForSync: true, wsUrl, wsParams: { user: 'alice' } })
  const bob = await createWsClient({ waitForSync: true, wsUrl, wsParams: { user: 'bob' } })
  /** @type {Array<number>} */
  const aliceCloseCodes = []
  recordCloseCodes(alice.provider, aliceCloseCodes)
  /** @type {Array<number>} */
  const bobCloseCodes = []
  recordCloseCodes(bob.provider, bobCloseCodes)
  kickPerms.alice = null
  // bob's live session keeps write access, so a (wrongly) rechecked bob would be closed on the
  // rw != r mismatch - guards that the users filter actually selects connections
  kickPerms.bob = docPermissionsPreset('r')
  // published via the shared hub, received by the kick hub's connections (same redis prefix)
  await yhub.recheckAuth(defaultDocRef, { users: [{ userid: 'alice' }] })
  await promise.until(5000, () => !alice.provider.wsconnected)
  t.assert(aliceCloseCodes.includes(wsCloseAuthRevoked), 'alice was closed with the auth close code')
  bob.ydoc.get().setAttr('x', 1)
  await promise.wait(1000)
  t.assert(bob.provider.wsconnected, 'bob is unaffected')
  t.assert(!bobCloseCodes.includes(wsCloseAuthRevoked), 'the users filter must not recheck unmatched connections')
  t.assert(alice.ydoc.get().getAttr('x') == null, 'alice no longer receives updates')
}

/**
 * @param {t.TestCase} tc
 */
export const testRecheckAuthClosesOnDowngrade = async tc => {
  resetKickPerms()
  const { createWsClient, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const wsUrl = utils.wsUrlFromPort(kickHubPort)
  const alice = await createWsClient({ waitForSync: true, wsUrl, wsParams: { user: 'alice' } })
  const bob = await createWsClient({ waitForSync: true, wsUrl, wsParams: { user: 'bob' } })
  /** @type {Array<number>} */
  const aliceCloseCodes = []
  recordCloseCodes(alice.provider, aliceCloseCodes)
  kickPerms.alice = docPermissionsPreset('r')
  // the userid string shorthand, end-to-end
  await yhub.recheckAuth(defaultDocRef, { users: ['alice'] })
  await promise.until(5000, () => aliceCloseCodes.includes(wsCloseAuthRevoked))
  // alice reconnects read-only: her edits must no longer reach bob
  await promise.until(5000, () => alice.provider.wsconnected)
  alice.ydoc.get().setAttr('hidden', '!')
  await promise.wait(1000)
  t.assert(alice.ydoc.get().getAttr('hidden') != null)
  t.assert(bob.ydoc.get().getAttr('hidden') == null, 'downgraded alice cannot write anymore')
  // an access upgrade (r -> rw) must also close - alice reconnects with write access restored
  // (and her read-only edits sync over)
  delete kickPerms.alice
  await yhub.recheckAuth(defaultDocRef, { users: ['alice'] })
  await promise.until(5000, () => aliceCloseCodes.filter(code => code === wsCloseAuthRevoked).length >= 2)
  await promise.until(5000, () => alice.provider.wsconnected)
  alice.ydoc.get().setAttr('visible', '!')
  await promise.until(5000, () => bob.ydoc.get().getAttr('visible') != null)
}

/**
 * @param {t.TestCase} tc
 */
export const testRecheckAuthForceDisconnect = async tc => {
  resetKickPerms()
  const { createWsClient, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const wsUrl = utils.wsUrlFromPort(kickHubPort)
  const alice = await createWsClient({ waitForSync: true, wsUrl, wsParams: { user: 'alice' } })
  const bob = await createWsClient({ waitForSync: true, wsUrl, wsParams: { user: 'bob' } })
  /** @type {Array<number>} */
  const closeCodes = []
  recordCloseCodes(alice.provider, closeCodes)
  recordCloseCodes(bob.provider, closeCodes)
  // the update can land in the same stream batch as the auth:check - a force disconnect midway
  // through the batch must not trip the 1011/backpressure error paths (see WSUser.sendData)
  alice.ydoc.get().setAttr('a', 42)
  await yhub.recheckAuth(defaultDocRef, { forceDisconnect: true })
  await promise.until(5000, () => closeCodes.length >= 2)
  t.assert(closeCodes.every(code => code === wsCloseAuthRevoked), 'both connections were closed with the auth close code')
  // access is unchanged - both reconnect (a force disconnect drops sessions, it doesn't revoke)
  await promise.until(5000, () => alice.provider.wsconnected && bob.provider.wsconnected)
}

/**
 * A pending auth:check entry in the stream must be applied to a connection that was set up
 * concurrently: the initial `lastReceivedClock` is past the entry, so the open handler re-checks
 * once instead. Pending `forceDisconnect` entries must NOT be replayed as a kick - that would
 * loop a legitimately (re-)authorized user until the entry ages out of the stream.
 *
 * @param {t.TestCase} tc
 */
export const testRecheckAuthPendingCheckOnConnect = async tc => {
  resetKickPerms()
  const { createWsClient, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const wsUrl = utils.wsUrlFromPort(kickHubPort)
  await yhub.recheckAuth(defaultDocRef, { forceDisconnect: true })
  await yhub.recheckAuth(defaultDocRef, { users: ['alice'] })
  const checksBefore = kickPermChecks
  const alice = createWsClient({ wsUrl, wsParams: { user: 'alice' } })
  /** @type {Array<number>} */
  const aliceCloseCodes = []
  recordCloseCodes(alice.provider, aliceCloseCodes)
  await alice.ydoc.whenSynced
  await promise.wait(500)
  t.assert(alice.provider.wsconnected, 'a pending force disconnect must not kick a freshly authorized connection')
  t.assert(!aliceCloseCodes.includes(wsCloseAuthRevoked), 'the pending directives were not replayed as kicks')
  t.assert(kickPermChecks === checksBefore + 2, 'exactly the upgrade check and the open-handler recheck ran')
}

/**
 * An auth plugin failure during a recheck must fail closed: the connection whose access can no
 * longer be verified is disconnected - but with the transient close code 1013, not the revoke
 * code 4401, so the client keeps reconnecting and recovers once the auth backend does.
 *
 * @param {t.TestCase} tc
 */
export const testRecheckAuthFailsClosed = async tc => {
  resetKickPerms()
  const { createWsClient, yhub, defaultDocRef } = await utils.createTestCase(tc)
  const wsUrl = utils.wsUrlFromPort(kickHubPort)
  const carol = await createWsClient({ waitForSync: true, wsUrl, wsParams: { user: 'carol' } })
  /** @type {Array<number>} */
  const closeCodes = []
  recordCloseCodes(carol.provider, closeCodes)
  kickPerms.carol = 'throw'
  await yhub.recheckAuth(defaultDocRef, { users: ['carol'] })
  await promise.until(5000, () => closeCodes.includes(1013))
  t.assert(!closeCodes.includes(wsCloseAuthRevoked), 'a transient auth failure must not look like a revoke')
  // the auth backend recovers - the still-reconnecting client syncs again
  delete kickPerms.carol
  await promise.until(5000, () => carol.provider.wsconnected)
}

/**
 * The error classes of the auth hooks on rest requests: a branded `apiError` passes its status
 * through (a 503 outage, a 401 rejecting a credential), an unbranded throw is an infrastructure
 * failure (503 - deny is a value, never a throw), and no credential at all is an anonymous caller
 * whose missing permissions answer 403, never 401.
 *
 * @param {t.TestCase} _tc
 */
export const testAuthPluginErrorClasses = async _tc => {
  resetKickPerms()
  const url = `http://localhost:${kickHubPort}/api/ydoc/v1/testOrg/anyDoc?user=eve`
  kickPerms.eve = 'throw503'
  const res503 = await fetch(url)
  t.assert(res503.status === 503, 'a branded apiError propagates its status')
  t.compare(buffer.decodeAny(new Uint8Array(await res503.arrayBuffer())), { error: 'auth backend unavailable' })
  kickPerms.eve = 'throw'
  const resThrow = await fetch(url)
  t.assert(resThrow.status === 503, 'an unbranded authorize error is a transient 503')
  t.compare(buffer.decodeAny(new Uint8Array(await resThrow.arrayBuffer())), { error: 'authorize unavailable' })
  // the jwt hub: a bad credential is rejected by the plugin's own branded 401, no credential is
  // an anonymous caller without a grant - 403
  const authUrl = `http://localhost:${authHubPort}/api/ydoc/v1/testOrg/anyDoc`
  const resBadToken = await fetch(`${authUrl}?auth=garbage`)
  t.assert(resBadToken.status === 401)
  t.compare(buffer.decodeAny(new Uint8Array(await resBadToken.arrayBuffer())), { error: 'invalid token' })
  const resAnon = await fetch(authUrl)
  t.assert(resAnon.status === 403, 'an anonymous caller without permissions is denied, not unauthenticated')
  t.assert(buffer.decodeAny(new Uint8Array(await resAnon.arrayBuffer())).code === 'missing-permission')
}
