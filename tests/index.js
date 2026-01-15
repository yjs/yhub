/* eslint-env node */

import * as api from './api.tests.js'
import * as auth from './auth.tests.js'
import * as ws from './ws.tests.js'
import * as storage from './storage.tests.js'
import { runTests } from 'lib0/testing'

runTests({
  storage,
  api,
  auth,
  ws
}).then(success => {
  process.exit(success ? 0 : 1)
})
