#!/usr/bin/env node

import * as env from 'lib0/environment'
import * as yredis from '@y/hub'
import * as Y from '@y/y'
import { createStorage } from '../src/storage.js'

console.log('starting worker')

const redisPrefix = env.ensureConf('redis-prefix')
const store = await createStorage(env.ensureConf('postgres'), {
  bucket: env.ensureConf('S3_YHUB_BUCKET'),
  endPoint: env.ensureConf('S3_ENDPOINT'),
  port: parseInt(env.ensureConf('S3_PORT'), 10),
  useSSL: env.ensureConf('S3_SSL') === 'true',
  accessKey: env.ensureConf('S3_ACCESS_KEY'),
  secretKey: env.ensureConf('S3_SECRET_KEY')
})

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
