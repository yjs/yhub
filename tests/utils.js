import * as Y from '@y/y'
import * as env from 'lib0/environment'
import { WebSocket } from 'ws'
import { WebsocketProvider } from '@y/websocket'
import * as t from 'lib0/testing' // eslint-disable-line
import * as promise from 'lib0/promise'
import { createYHub } from '@y/hub'
import * as number from 'lib0/number'
import { S3PersistenceV1 } from '@y/hub/plugins/s3'
import postgres from 'postgres'
import * as object from 'lib0/object'
import * as types from '../src/types.js'
import { encodeRoomName } from '../src/stream.js'

// Clean up test data - only delete if table exists
const sql = postgres(env.ensureConf('postgres'))
const tableExists = await sql`
  SELECT EXISTS (
    SELECT FROM pg_tables
    WHERE tablename = 'yhub_ydoc_v1'
  );
`
if (tableExists?.[0]?.exists) {
  await sql`DELETE from yhub_ydoc_v1`
}

const yhubPort = number.parseInt(env.getConf('port') || '9999')
export const yhub = await createYHub({
  redis: {
    url: env.ensureConf('redis'),
    prefix: 'yhub:testing',
    taskDebounce: 10000,
    minMessageLifetime: 3000
  },
  postgres: env.ensureConf('postgres'),
  persistence: [
    new S3PersistenceV1({
      bucket: env.ensureConf('S3_YHUB_TEST_BUCKET'),
      endPoint: env.ensureConf('S3_ENDPOINT'),
      port: parseInt(env.ensureConf('S3_PORT'), 10),
      useSSL: env.ensureConf('S3_SSL') === 'true',
      accessKey: env.ensureConf('S3_ACCESS_KEY'),
      secretKey: env.ensureConf('S3_SECRET_KEY')
    })
  ],
  server: {
    port: yhubPort,
    auth: types.createAuthPlugin({
      // pick a "unique" userid
      async readAuthInfo (req) {
        return { userid: 'user1' }
      },
      // always grant rw access
      async getAccessType () { return 'rw' }
    })
  },
  worker: {
    taskConcurrency: 500
  }
})
{
  const redis = yhub.stream.redis
  const redisKeys = await redis.keys('yhub:testing:room:*')
  if (redisKeys.length > 0) {
    await redis.del(redisKeys)
  }
  redis.xTrim(yhub.stream.workerStreamName, 'MAXLEN', 0)
}

/**
 * @param {Partial<import('../src/types.js').YHubConfig>} conf
 */
export const createTestHub = (conf) => {
  const testConf = object.assign({}, yhub.conf, { server: null, worker: null }, conf)
  return createYHub(testConf)
}

/**
 * @param {number} port
 */
export const wsUrlFromPort = port => `ws://localhost:${port}/ws/${defaultOrg}`

export const defaultOrg = 'testOrg'
export const yhubHost = `localhost:${yhubPort}`
export const wsUrl = wsUrlFromPort(yhubPort)

/**
 * @template {boolean} WaitForSync
 * @param {t.TestCase} tc
 * @param {object} params
 * @param {string} [params.docid]
 * @param {string} [params.branch]
 * @param {boolean} [params.gc]
 * @param {boolean} [params.syncAwareness]
 * @param {WaitForSync} [params.waitForSync]
 * @param {string} [params.wsUrl]
 * @param {{[K:string]:any}} [params.wsParams]
 * @return {WaitForSync extends true ? Promise<{ ydoc: Y.Doc, provider: WebsocketProvider }> : { ydoc: Y.Doc, provider: WebsocketProvider }}
 */
const createWsClient = (tc, { docid = 'index', branch = 'main', gc = true, syncAwareness = true, waitForSync, wsUrl: _wsUrl = wsUrl, wsParams = {} } = {}) => {
  const testPrefix = tc.testName
  const guid = testPrefix + '-' + docid
  const ydoc = new Y.Doc({ gc, guid })
  const provider = new WebsocketProvider(_wsUrl, guid, ydoc, { WebSocketPolyfill: /** @type {any} */ (WebSocket), disableBc: true, params: { branch, gc: gc.toString(), ...wsParams } })
  previousClients.push(ydoc)
  previousClients.push(provider)
  previousClients.push(provider.awareness)
  // @todo this should be part of @y/websocket
  provider.once('sync', () => {
    ydoc.emit('sync', [true, ydoc])
  })
  if (!syncAwareness) {
    provider.awareness.destroy()
  }
  if (waitForSync) {
    return /** @type {WaitForSync extends true ? Promise<{ ydoc: Y.Doc, provider: WebsocketProvider }> : { ydoc: Y.Doc, provider: WebsocketProvider }} */ (ydoc.whenSynced.then(() => ({ ydoc, provider })))
  }
  return /** @type {WaitForSync extends true ? Promise<{ ydoc: Y.Doc, provider: WebsocketProvider }> : { ydoc: Y.Doc, provider: WebsocketProvider }} */ ({ ydoc, provider })
}

/**
 * @type {Array<{destroy: () => any}>}
 */
const previousClients = []

export const cleanPreviousClients = () => {
  previousClients.forEach(client => client.destroy())
  previousClients.length = 0
}

/**
 * @param {t.TestCase} tc
 */
export const createTestCase = async tc => {
  const defaultRoom = { org: defaultOrg, docid: tc.testName + '-index', branch: 'main' }
  cleanPreviousClients()
  await waitTasksProcessed(yhub)
  return {
    // this must match with the default values in createWsClient
    defaultRoom,
    defaultStream: encodeRoomName(defaultRoom, yhub.stream.prefix),
    yhub,
    org: defaultOrg,
    /**
     * @template {boolean} [WaitForSync=false]
     * @param {object} [params]
     * @param {string} [params.docid]
     * @param {string} [params.branch]
     * @param {boolean} [params.gc]
     * @param {boolean} [params.syncAwareness]
     * @param {WaitForSync} [params.waitForSync]
     * @param {string} [params.wsUrl]
     * @param {{[K:string]:any}} [params.wsParams]
     * @return {WaitForSync extends true ? Promise<{ ydoc: Y.Doc, provider: WebsocketProvider }> : { ydoc: Y.Doc, provider: WebsocketProvider }}
     */
    createWsClient: (params) => createWsClient(tc, params)
  }
}

/**
 * @param {Y.Doc} ydoc1
 * @param {Y.Doc} ydoc2
 */
export const waitDocsSynced = (ydoc1, ydoc2) => {
  console.info('waiting for docs to sync...')
  return promise.until(5000, () => {
    const cids1 = Y.createContentIdsFromDoc(ydoc1)
    const cids2 = Y.createContentIdsFromDoc(ydoc2)
    const diff = Y.excludeContentIds(cids1, cids2)
    const isSynced = diff.deletes.isEmpty() && diff.inserts.isEmpty()
    isSynced && console.info('docs sycned!')
    return isSynced
  }).catch(err => {
    console.info('prematurely cancelled waiting for sync', err)
    promise.resolve(err)
  })
}

/**
 * @param {import('../src/index.js').YHub} yhub
 */
export const waitTasksProcessed = async yhub =>
  t.groupAsync('waiting for all tasks to be processed', () => promise.untilAsync(async () => {
    const [pendingTasksSize, activeStreams] = await promise.all([yhub.stream.getPendingTasksSize(), yhub.stream.getActiveStreams().then(as => as.length)])
    console.log({ pendingTasksSize, activeStreams })
    if (pendingTasksSize > 0) {
      await promise.wait(1000)
    }
    return pendingTasksSize === 0 && activeStreams === 0
  }, (yhub.conf.redis.minMessageLifetime ?? 10000) * 50))
