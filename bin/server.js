#!/usr/bin/env node

/**
 * The server component: accepts client connections and streams updates through redis. Run at
 * least one worker (`bin/worker.js`) alongside it, otherwise nothing is ever persisted.
 */

import * as yhub from '@y/hub'
import { conf, shutdownDrainMs } from './conf.js'

const hub = await yhub.createYHub({ ...conf, worker: null })

// graceful shutdown (see `YHub.destroy`) - a second Ctrl-C terminates right away
const destroy = () => hub.destroy({ drainMs: shutdownDrainMs })
process.once('SIGTERM', destroy)
process.once('SIGINT', destroy)
