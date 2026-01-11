#!/usr/bin/env node

import * as number from 'lib0/number'
import * as env from 'lib0/environment'
import * as yredis from '@y/redis'
import { createPostgresStorage } from '../src/storage.js'

const port = number.parseInt(env.getConf('port') || '3002')
const redisPrefix = env.ensureConf('redis-prefix')
const checkPermCallbackUrl = env.ensureConf('AUTH_PERM_CALLBACK')
const store = await createPostgresStorage(env.ensureConf('postgres'))

yredis.createYWebsocketServer({ port, store, checkPermCallbackUrl, redisPrefix })
