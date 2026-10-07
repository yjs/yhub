#!/usr/bin/env node

/**
 * The worker component: merges pending updates from redis, persists them, and trims the redis
 * streams. Runs without a websocket server.
 */

import * as yhub from '@y/hub'
import { conf, shutdownDrainMs } from './conf.js'

const hub = await yhub.createYHub({ ...conf, server: null })

// graceful shutdown (see `YHub.destroy`) - a second Ctrl-C terminates right away
const destroy = () => hub.destroy({ drainMs: shutdownDrainMs })
process.once('SIGTERM', destroy)
process.once('SIGINT', destroy)
