/**
 * Builds a y/hub configuration from environment variables (or the equivalent `--kebab-case`
 * cli parameters). This is what `bin/yhub.js`, `bin/server.js` and `bin/worker.js` use.
 *
 * See `.env.template` for the full list of supported variables.
 */

import * as env from 'lib0/environment'
import * as number from 'lib0/number'
import * as random from 'lib0/random'
import { S3PersistenceV1 } from '@y/hub/plugins/s3'
import * as types from '../src/types.js'

const userIdChoices = [
  'Calvin Hobbes',
  'Charlie Brown',
  'Dilbert Adams',
  'Garfield'
]

/**
 * How long `YHub.destroy` waits for running tasks and closing connections on SIGTERM/SIGINT.
 * Generous, because a compaction can take a while - the shutdown is over as soon as they are done.
 */
export const shutdownDrainMs = number.parseInt(env.getConf('shutdown-drain-ms') || '60000')

const bucket = env.getConf('s3-yhub-bucket')
const corsOrigin = env.getConf('cors-origin') || null

/**
 * @type {import('../src/types.js').YHubConfig}
 */
export const conf = {
  redis: {
    url: env.ensureConf('redis'),
    prefix: env.getConf('redis-prefix') || 'yhub',
    taskDebounce: number.parseInt(env.getConf('redis-task-debounce') || '10000'),
    minMessageLifetime: number.parseInt(env.getConf('redis-min-message-lifetime') || '60000')
  },
  postgres: env.ensureConf('postgres'),
  persistence: bucket == null
    ? []
    : [
        new S3PersistenceV1({
          bucket,
          endPoint: env.ensureConf('s3-endpoint'),
          port: number.parseInt(env.ensureConf('s3-port')),
          useSSL: env.ensureConf('s3-ssl') === 'true',
          accessKey: env.ensureConf('s3-access-key'),
          secretKey: env.ensureConf('s3-secret-key')
        })
      ],
  server: {
    port: number.parseInt(env.getConf('port') || '4400'),
    // CORS_ORIGIN unset leaves cors unset: same-origin pages and non-browser clients only. A
    // comma-separated value becomes an allowlist, '*' opens the api to every origin - the
    // latter is safe here only because `credentials` stays off; browsers reject that pair.
    cors: corsOrigin === null ? undefined : { origin: corsOrigin.includes(',') ? corsOrigin.split(',').map(origin => origin.trim()).filter(origin => origin !== '') : corsOrigin.trim() },
    auth: types.createAuthPlugin({
      // Open demo server: the userid is taken straight from the connection
      // string (e.g. ws://host/ws/:org/:docid?userid=alice). Attributions are
      // saved against this userid. Falls back to a random name when omitted.
      async authenticate (req) {
        const userid = req.getQuery('userid')
        return { userid: userid || random.oneOf(userIdChoices) }
      },
      // this demo configuration grants everyone full document access - including the
      // destructive permissions the old blanket 'rw' implied. No org/branch/global grants:
      // scopes without a handler deny, and this demo serves no endpoints at those scopes.
      authorize: types.createAuthorize({
        document: async () => ({
          type: 'permissions:document:v1',
          ydoc: 'cru-',
          awareness: '-ru-',
          history: { from: 0, rollback: true, prune: true, version: 'crud', publish: true },
          delete: ['soft'],
          endpoint: { '*': 'crud' }
        })
      })
    })
  },
  worker: {
    taskConcurrency: 5
  }
}
