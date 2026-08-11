import pino from 'pino'
import * as env from 'lib0/environment'

export const logger = pino({ name: 'yhub', level: env.getConf('log-level') || 'info' })
