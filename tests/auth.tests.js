import * as t from 'lib0/testing'
import * as jwt from 'lib0/crypto/jwt'
import * as ecdsa from 'lib0/crypto/ecdsa'
import * as s from 'lib0/schema'
import * as types from '../src/types.js'
import * as utils from './utils.js'
import * as f from 'lib0/function'
import * as time from 'lib0/time'
import * as promise from 'lib0/promise'

const authPrivateKey = await ecdsa.importKeyJwk({ key_ops: ['verify'], ext: true, kty: 'EC', x: '96pShK8Z3iJ8UZpN4tuyv9CuPuzwWgC_I72N6ZUNWOSBDflVxwYPtL3PcCgCF2aE', y: 'Q39u2jtATgoBd9D8Tx744v6KljwE3iOZr30Rf8yuVT3UgGEi0bcKufUGVSeKls8s', crv: 'P-384' })
const authPublicKey = await ecdsa.importKeyJwk({ key_ops: ['verify'], ext: true, kty: 'EC', x: '96pShK8Z3iJ8UZpN4tuyv9CuPuzwWgC_I72N6ZUNWOSBDflVxwYPtL3PcCgCF2aE', y: 'Q39u2jtATgoBd9D8Tx744v6KljwE3iOZr30Rf8yuVT3UgGEi0bcKufUGVSeKls8s', crv: 'P-384' })

const authHubPort = 9009

/**
 * This is an example of how you could add auth support via jwt.
 *
 * This server reads the auth information from the auth url-parameter.
 * Alternatively, the auth info could also be stored in the protocol information of the websockets
 * to hide the auth info from logging tools.
 */
utils.createTestHub({
  worker: null,
  server: {
    port: authHubPort,
    auth: types.createAuthPlugin({
      async readAuthInfo (req) {
        const authJwt = req.getParameter('auth') || ''
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
