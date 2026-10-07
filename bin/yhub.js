#!/usr/bin/env node

/**
 * A demo server that runs both the server and the worker component in a single process.
 *
 * Read the docs for instructions on how to properly set up servers and workers.
 */

import * as yhub from '@y/hub'
import { conf, shutdownDrainMs } from './conf.js'

const hub = await yhub.createYHub(conf)

// graceful shutdown (see `YHub.destroy`) - a second Ctrl-C terminates right away
const destroy = () => hub.destroy({ drainMs: shutdownDrainMs })
process.once('SIGTERM', destroy)
process.once('SIGINT', destroy)
