#!/usr/bin/env node

import * as number from 'lib0/number'
import * as env from 'lib0/environment'
import * as yredis from '@y/hub'
import { createStorage } from '../src/storage.js'

console.log('starting server')

const port = number.parseInt(env.getConf('port') || '3002')
const redisPrefix = env.ensureConf('redis-prefix')
const checkPermCallbackUrl = env.ensureConf('AUTH_PERM_CALLBACK')
const store = await createStorage(env.ensureConf('postgres'), {
  bucket: env.ensureConf('S3_YHUB_BUCKET'),
  endPoint: env.ensureConf('S3_ENDPOINT'),
  port: parseInt(env.ensureConf('S3_PORT'), 10),
  useSSL: env.ensureConf('S3_SSL') === 'true',
  accessKey: env.ensureConf('S3_ACCESS_KEY'),
  secretKey: env.ensureConf('S3_SECRET_KEY')
})

yredis.createYHubServer({ port, store, checkPermCallbackUrl, redisPrefix })
