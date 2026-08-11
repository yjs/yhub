#!/usr/bin/env node

/**
 * The server component: accepts client connections and streams updates through redis. Run at
 * least one worker (`bin/worker.js`) alongside it, otherwise nothing is ever persisted.
 */

import * as yhub from '@y/hub'
import { conf } from './conf.js'

yhub.createYHub({ ...conf, worker: null })
