#!/usr/bin/env node

/**
 * This is a demo server that starts both a server and a worker process in a single application.
 *
 * Read the docs for instructions on how to properly set up servers and workers.
 */

import * as number from 'lib0/number'
import * as env from 'lib0/environment'
import * as yhub from '@y/hub'
import * as random from 'lib0/random'
import * as logging from 'lib0/logging'

const userIdChoices = [
  'Calvin Hobbes',
  'Charlie Brown',
  'Dilbert Adams',
  'Garfield'
]

const port = number.parseInt(env.getConf('port') || '3002')

logging.print(logging.GREEN, 'starting server on port ' + port)

yhub.createYHub({
  redis: {
    url: env.ensureConf('redis'),
    prefix: 'yhub',
    taskDebounce: 10000,
    minMessageLifetime: 60000
  },
  postgres: env.ensureConf('postgres'),
  persistence: [],
  server: {
    port,
    auth: {
      // pick a "unique" userid
      async readAuthInfo (req) {
        return { userid: random.oneOf(userIdChoices) }
      },
      // always grant rw access
      async getAccessType () { return 'rw' }
    }
  },
  worker: {
    taskConcurrency: 5
  }
})
