#!/usr/bin/env node

/**
 * A demo server that runs both the server and the worker component in a single process.
 *
 * Read the docs for instructions on how to properly set up servers and workers.
 */

import * as yhub from '@y/hub'
import { conf } from './conf.js'

yhub.createYHub(conf)
