import * as t from 'lib0/testing'
import * as jwt from 'lib0/crypto/jwt'
import * as ecdsa from 'lib0/crypto/ecdsa'
import * as s from 'lib0/schema'
import * as types from '../src/types.js'
import * as utils from './utils.js'
import * as f from 'lib0/function'
import * as time from 'lib0/time'
import * as promise from 'lib0/promise'

const authPrivateKey = await ecdsa.importKeyJwk({ key_ops: ['sign'], ext: true, kty: 'EC', x: '96pShK8Z3iJ8UZpN4tuyv9CuPuzwWgC_I72N6ZUNWOSBDflVxwYPtL3PcCgCF2aE', y: 'Q39u2jtATgoBd9D8Tx744v6KljwE3iOZr30Rf8yuVT3UgGEi0bcKufUGVSeKls8s', crv: 'P-384', d: 'BS_hqq6UMpuqS10oIWzEyTUt7RRQrysUMUdlwUyVimV_CTTNEpxXFW9_D0NA9rHt' })
const authPublicKey = await ecdsa.importKeyJwk({ key_ops: ['verify'], ext: true, kty: 'EC', x: '96pShK8Z3iJ8UZpN4tuyv9CuPuzwWgC_I72N6ZUNWOSBDflVxwYPtL3PcCgCF2aE', y: 'Q39u2jtATgoBd9D8Tx744v6KljwE3iOZr30Rf8yuVT3UgGEi0bcKufUGVSeKls8s', crv: 'P-384' })

const authHubPort = 9009

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
      async readAuthInfo (req) {
        const authJwt = req.getQuery('auth')
        if (authJwt == null || authJwt.length === 0) {
          throw new Error('no auth token')
        }
        const auth = await jwt.verifyJwt(authPublicKey, authJwt)
        const authInfo = s.$object({ rooms: s.$array(s.$object({ room: types.$room, accessType: types.$accessType })), userid: s.$string }).expect(auth.payload)
        return authInfo
      },
      async getAccessType (authInfo, room) {
        const roomAccess = authInfo.rooms.find(r => f.equalityDeep(room, r.room))
        return roomAccess?.accessType || null
      }
    })
  }
})

/**
 * This is a function the server would use to create a jwt. Note that the private key must be kept
 * private. The authenticated client should only know about the jwt.
 */
const createJwtAccessToken = async (accessType = 'rw') => {
  const token = await jwt.encodeJwt(authPrivateKey, {
    iss: 'yhub-demo',
    exp: time.getUnixTime() + 60 * 60 * 1000, // token expires in one hour
    userid: 'testUser', // associate the client with a unique id that can will be used to check permissions
    rooms: [{ room: { org: 'testOrg', docid: 'testSampleAuthServer-index', branch: 'main' }, accessType }]
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
