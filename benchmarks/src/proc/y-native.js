/**
 * Y1.7. `src/y-utils.js:6` reads `use-y-native` once at module load, so the
 * native-vs-JS merge comparison needs a second process. This one is forked with
 * `USE_Y_NATIVE=1` and returns the same rows Y1.1 and Y1.4 produce.
 *
 * The imports are dynamic so the logger is silenced before `y-utils` logs its
 * "using experimental y-native" warning into the benchmark output.
 */

const { logger } = await import('../../../src/logger.js')
logger.level = 'silent'

const { runY11, runY14 } = await import('../suites/y1-primitives.js')

process.send?.({ y11: runY11(), y14: runY14() })
