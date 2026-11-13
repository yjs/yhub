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
import { createAuthPlugin } from '../src/auth.js'

const userIdChoices = [
  'Calvin Hobbes',
  'Charlie Brown',
  'Dilbert Adams',
  'Garfield'
]

/**
 * How long `YHub.destroy` waits for running tasks and closing connections on SIGTERM/SIGINT - an
 * upper bound, the shutdown is over as soon as they are done. 15s plus the ~13s of pending S3
 * deletes fits kubernetes' default grace period of 30s.
 */
export const shutdownDrainMs = number.parseInt(env.getConf('shutdown-drain-ms') || '15000')

/**
 * @type {import('../src/permissions.js').DocumentPermissionsV1}
 */
const documentGrant = {
  type: 'permissions:document:v1',
  ydoc: 'cru-',
  awareness: '-ru-',
  history: { from: 0, rollback: true, prune: true, version: 'crud', publish: true },
  delete: ['soft'],
  endpoint: { '*': 'crud' }
}

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
  auth: createAuthPlugin({
    // Open demo server: the userid is taken straight from the connection
    // string (e.g. ws://host/ws/:org/:docid?userid=alice). Attributions are
    // saved against this userid. Falls back to a random name when omitted.
    authenticate: async (_yhub, req) => {
      const userid = req.getQuery('userid')
      return { userid: userid || random.oneOf(userIdChoices) }
    },
    // this demo configuration grants everyone full document access - including the
    // destructive permissions the old blanket 'rw' implied. It answers no org/branch/global
    // permissions, so the routes of those scopes (the built-in updated listings) answer 500.
    // The batch check (`filterAuthorizedDocuments`) defaults to asking this getter.
    getDocumentPermissions: async (_yhub, docRefs) => docRefs.map(resource => ({ resource, permissions: documentGrant }))
  }),
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
    cors: corsOrigin === null ? undefined : { origin: corsOrigin.includes(',') ? corsOrigin.split(',').map(origin => origin.trim()).filter(origin => origin !== '') : corsOrigin.trim() }
  },
  worker: {
    taskConcurrency: 5
  }
}
