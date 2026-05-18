/* eslint-env node */

import * as api from './api.tests.js'
import * as auth from './auth.tests.js'
import * as ws from './ws.tests.js'
import * as storage from './storage.tests.js'
import * as computeWorker from './computeWorker.tests.js'
import * as agents from './agents.tests.js'
import { runTests } from 'lib0/testing'

runTests({
  computeWorker,
  storage,
  api,
  auth,
  ws,
  agents
}).then(success => {
  process.exit(success ? 0 : 1)
})
