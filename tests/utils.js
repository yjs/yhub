import * as Y from 'yjs'
import * as env from 'lib0/environment'
import * as json from 'lib0/json'
import * as ecdsa from 'lib0/crypto/ecdsa'
import { WebSocket } from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as redis from 'redis'
import * as time from 'lib0/time'
import * as jwt from 'lib0/crypto/jwt'
import * as t from 'lib0/testing' // eslint-disable-line
import * as promise from 'lib0/promise'
import * as array from 'lib0/array'

import { createYWebsocketServer } from '../src/server.js'
import { createPostgresStorage } from '../src/storage.js'
import * as api from '../src/api.js'

/**
 * @type {Array<{ destroy: function():Promise<void>}>}
 */
export const prevClients = []

export const authPrivateKey = await ecdsa.importKeyJwk(json.parse(env.ensureConf('auth-private-key')))
export const authPublicKey = await ecdsa.importKeyJwk(json.parse(env.ensureConf('auth-public-key')))

export const redisPrefix = 'ytests'

export const authDemoServerPort = 5173
export const authDemoServerUrl = `http://localhost:${authDemoServerPort}`
export const checkPermCallbackUrl = `${authDemoServerUrl}/auth/perm/`
export const authTokenUrl = `${authDemoServerUrl}/auth/token`

export const yredisPort = 9999
export const yhubHost = `localhost:${yredisPort}`
export const yredisUrl = `ws://${yhubHost}/`

export const storage = await createPostgresStorage(env.ensureConf('postgres-testing'))
// Clean up test data - only delete if table exists
const tableExists = await storage.sql`
  SELECT EXISTS (
    SELECT FROM pg_tables
    WHERE tablename = 'yhub_updates_v1'
  );
`
if (tableExists?.[0]?.exists) {
  await storage.sql`DELETE from yhub_updates_v1`
}

const authToken = await jwt.encodeJwt(authPrivateKey, {
  iss: 'my-auth-server',
  exp: time.getUnixTime() + 60 * 60 * 1000, // token expires in one hour
  yuserid: 'user1' // fill this with a unique id of the authorized user
})

/**
 * @param {t.TestCase} tc
 * @param {string} room
 * @param {object} params
 * @param {string} [params.branch]
 * @param {boolean} [params.gc]
 */
const createWsClient = (tc, room, { branch = 'main', gc = true } = {}) => {
  const ydoc = new Y.Doc({ gc })
  const roomPrefix = tc.testName
  const provider = new WebsocketProvider(yredisUrl, roomPrefix + '-' + room, ydoc, { WebSocketPolyfill: /** @type {any} */ (WebSocket), disableBc: true, params: { branch, gc: gc.toString() }, protocols: [`yauth-${authToken}`] })
  return { ydoc, provider }
}

export const createWorker = async () => {
  const worker = await api.createWorker(storage, redisPrefix, {})
  prevClients.push(worker.client)
  return worker
}

export const createServer = async () => {
  const server = await createYWebsocketServer({ port: yredisPort, store: storage, redisPrefix, checkPermCallbackUrl })
  prevClients.push(server)
  return server
}

const createApiClient = async () => {
  const client = await api.createApiClient(storage, redisPrefix)
  prevClients.push(client)
  return client
}

/**
 * @param {t.TestCase} tc
 */
export const createTestCase = async tc => {
  await promise.all(prevClients.map(c => c.destroy()))
  prevClients.length = 0
  const redisClient = redis.createClient({ url: api.redisUrl })
  await promise.untilAsync(async () => {
    try {
      await redisClient.connect()
    } catch (err) {
      console.warn(`Can't connect to redis! url: ${api.redisUrl}`)
      return false
    }
    return true
  }, 10000)
  // flush existing content
  const keysToDelete = await redisClient.keys(redisPrefix + ':*')
  await redisClient.del(keysToDelete)
  prevClients.push({ destroy: () => redisClient.quit().then(() => {}) })
  const server = await createServer()
  const [apiClient, worker] = await promise.all([createApiClient(), createWorker()])
  return {
    redisClient,
    apiClient,
    server,
    worker,
    /**
     * @param {string} docid
     * @param {object} [opts]
     * @param {string} [opts.branch]
     * @param {boolean} [opts.gc]
     */
    createWsClient: (docid, opts) => createWsClient(tc, docid, opts)
  }
}

/**
 * @param {Y.Doc} ydoc1
 * @param {Y.Doc} ydoc2
 */
export const waitDocsSynced = (ydoc1, ydoc2) => {
  console.info('waiting for docs to sync...')
  return promise.until(5000, () => {
    const e1 = Y.encodeStateAsUpdateV2(ydoc1)
    const e2 = Y.encodeStateAsUpdateV2(ydoc2)
    const isSynced = array.equalFlat(e1, e2)
    isSynced && console.info('docs sycned!')
    return isSynced
  }).catch(err => {
    console.info('prematurely cancelled waiting for sync')
    promise.resolve(err)
  })
}
