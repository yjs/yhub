#!/usr/bin/env node

/**
 * The worker component: merges pending updates from redis, persists them, and trims the redis
 * streams. Runs without a websocket server.
 */

import * as yhub from '@y/hub'
import { conf } from './conf.js'

yhub.createYHub({ ...conf, server: null })
