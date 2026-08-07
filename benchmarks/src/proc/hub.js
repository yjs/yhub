import { createYHub, logger } from '../../../src/index.js'
import { S3PersistenceV1 } from '../../../src/plugins/s3.js'
import { createAuthPlugin } from '../../../src/types.js'
import { createChildMetrics, createS3Counters, countS3Ops } from '../metrics.js'

/**
 * Child process running one y/hub role.
 *
 * Server and worker are separate processes so that memory and CPU are
 * attributable per role — a single in-process hub would report one RSS number
 * covering both, and the multi-pod benchmarks (Y4.4, Y6.5) would be impossible.
 * The role is decided purely by config: `worker: null` makes `startWorker()`
 * return immediately, `server: null` skips the websocket server.
 *
 * Settings arrive as JSON in argv[2]. Everything else is IPC:
 *   parent -> child   { t: 'mark' } | { t: 'collect' } | { t: 'stop' }
 *   child  -> parent  { t: 'ready' } | { t: 'metrics', data } | { t: 'task', ... }
 */

const settings = JSON.parse(process.argv[2])

logger.level = process.env.BENCH_DEBUG ? 'debug' : 'silent'

const s3 = createS3Counters()
const persistence = countS3Ops(new S3PersistenceV1(settings.dbs.s3), s3)

/** @type {Array<{ durationMs: number, error: boolean }>} */
const tasks = []
/** @type {Array<{ gcBytes: number, nongcBytes: number, contentmapBytes: number }>} */
const compactions = []

const yhub = await createYHub({
  redis: {
    url: settings.dbs.redis,
    prefix: settings.dbs.redisPrefix,
    taskDebounce: settings.hub.taskDebounce,
    minMessageLifetime: settings.hub.minMessageLifetime,
    cacheTtl: settings.hub.cacheTtl
  },
  postgres: settings.dbs.postgres,
  persistence: [persistence],
  computePoolSize: settings.hub.computePoolSize ?? undefined,
  server: settings.role === 'server'
    ? {
        port: settings.port,
        auth: createAuthPlugin({
          async readAuthInfo () { return { userid: 'bench' } },
          async getAccessType () { return 'rw' }
        })
      }
    : null,
  worker: settings.role === 'worker'
    ? {
        taskConcurrency: settings.hub.taskConcurrency,
        events: {
          // Sizes are reported as their own stream, without the room — every
          // benchmark that reads them compacts one room at a time.
          docUpdate: d => compactions.push({
            gcBytes: d.gcDoc?.byteLength ?? 0,
            nongcBytes: d.nongcDoc?.byteLength ?? 0,
            contentmapBytes: d.contentmap?.byteLength ?? 0
          }),
          taskComplete: e => tasks.push({ durationMs: e.duration, error: e.error != null })
        }
      }
    : null
})

const metrics = createChildMetrics({
  intervalMs: settings.sampleIntervalMs,
  queueDepth: () => yhub.computePool.queue.length,
  s3
})

process.on('message', /** @param {any} msg */ msg => {
  if (msg.t === 'mark') {
    tasks.length = 0
    compactions.length = 0
    metrics.mark()
    process.send?.({ t: 'marked' })
  } else if (msg.t === 'collect') {
    process.send?.({ t: 'metrics', data: { ...metrics.collect(), tasks: tasks.slice(), compactions: compactions.slice() } })
  } else if (msg.t === 'stop') {
    process.exit(0)
  }
})

process.send?.({ t: 'ready', role: settings.role, port: settings.port })
