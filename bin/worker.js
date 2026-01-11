#!/usr/bin/env node

import * as env from 'lib0/environment'
import * as yredis from '@y/redis'
import * as Y from 'yjs'
import { createPostgresStorage } from '../src/storage.js'

const redisPrefix = env.ensureConf('redis-prefix')
const store = await createPostgresStorage(env.ensureConf('postgres'))

let ydocUpdateCallback = env.getConf('ydoc-update-callback')
if (ydocUpdateCallback != null && ydocUpdateCallback.slice(-1) !== '/') {
  ydocUpdateCallback += '/'
}

/**
 * @type {(room: string, ydoc: Y.Doc) => Promise<void>}
 */
const updateCallback = async (room, ydoc) => {
  if (ydocUpdateCallback != null) {
    // call YDOC_UPDATE_CALLBACK here
    const formData = new FormData()
    // @todo only convert ydoc to updatev2 once
    formData.append('ydoc', new Blob([Y.encodeStateAsUpdateV2(ydoc)]))
    // @todo should add a timeout to fetch (see fetch signal abortcontroller)
    const res = await fetch(new URL(room, ydocUpdateCallback), { body: formData, method: 'PUT' })
    if (!res.ok) {
      console.error(`Issue sending data to YDOC_UPDATE_CALLBACK. status="${res.status}" statusText="${res.statusText}"`)
    }
  }
}

yredis.createWorker(store, redisPrefix, {
  updateCallback
})
