import * as t from 'lib0/testing'
import * as promise from 'lib0/promise'
import * as env from 'lib0/environment'
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import { wsCloseDraining } from '@y/hub'
import * as utils from './utils.js'

// not TEST_PORT + 1: that one is the auth suite's hub, and uws binds a port that is already taken
// without an error (SO_REUSEPORT) - two hubs on it would silently split the connections
const shutdownPort = utils.testHubPort(-1)

/**
 * Retried every 100ms until the server listens.
 *
 * @param {string} url
 * @param {number} [retries]
 * @return {Promise<WebSocket>} resolves on the first message - the initial sync was sent
 */
const connect = (url, retries = 300) => promise.create(/** @param {(ws: WebSocket) => void} resolve */ (resolve, reject) => {
  const ws = new WebSocket(url)
  ws.once('message', () => resolve(ws))
  ws.once('error', reject)
}).catch(err => retries > 0 ? promise.wait(100).then(() => connect(url, retries - 1)) : promise.reject(err))

/**
 * SIGTERM shuts `bin/yhub.js` (server and worker in one process) down gracefully: a connected
 * client is told 4503, and the process then exits by itself - nothing it opened is left holding
 * the event loop. A child process, because only an exit proves that: the uws sockets don't show up
 * in `process.getActiveResourcesInfo()`.
 *
 * @param {t.TestCase} tc
 */
export const testShutdownOnSigterm = async tc => {
  await utils.createTestCase(tc)
  const child = spawn(process.execPath, ['bin/yhub.js'], {
    env: {
      ...process.env,
      PORT: shutdownPort.toString(),
      POSTGRES: env.ensureConf('postgres-testing'),
      S3_YHUB_BUCKET: env.ensureConf('S3_YHUB_TEST_BUCKET'),
      // its own prefix - its worker must not claim the tasks of the shared test hub
      REDIS_PREFIX: 'yhub:testing:shutdown',
      SHUTDOWN_DRAIN_MS: '5000',
      LOG_LEVEL: 'warn'
    },
    stdio: 'inherit'
  })
  try {
    const client = await connect(`${utils.wsUrlFromPort(shutdownPort)}/${tc.testName}`)
    const closed = promise.create(resolve => client.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
    child.kill('SIGTERM')
    // a second signal while draining - both handlers end up in the same destroy
    child.kill('SIGINT')
    t.compare(await closed, { code: wsCloseDraining, reason: 'server shutting down' })
    await promise.until(10_000, () => child.exitCode !== null || child.signalCode !== null)
    t.assert(child.exitCode === 0, 'exited by itself, cleanly')
  } finally {
    child.kill('SIGKILL')
  }
}
