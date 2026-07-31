import { fork } from 'node:child_process'
import { createClient } from 'redis'
import postgres from 'postgres'
import * as promise from 'lib0/promise'
import config from './config.js'
import { sumProcessMetrics } from './metrics.js'

/**
 * Starts and stops the y/hub processes under test, and owns the parent-side
 * probes (Redis stream lengths, Postgres row counts).
 *
 * Overrides that differ between benchmarks — `taskDebounce`, `taskConcurrency`,
 * process counts — cause a restart; identical ones reuse the running cluster,
 * so a full sweep does not pay a boot per row.
 */

const hubEntry = new URL('./proc/hub.js', import.meta.url).pathname

/**
 * @param {any} child
 * @param {any} msg
 * @param {string} expect
 */
const request = (child, msg, expect) => promise.create((resolve, reject) => {
  /** @param {any} m */
  const onMessage = m => {
    if (m.t !== expect) return
    cleanup()
    resolve(m)
  }
  const onExit = () => { cleanup(); reject(new Error('hub process exited while waiting for ' + expect)) }
  const cleanup = () => { child.off('message', onMessage); child.off('exit', onExit) }
  child.on('message', onMessage)
  child.on('exit', onExit)
  child.send(msg)
})

export class Cluster {
  /**
   * @param {{ servers: number, workers: number, taskDebounce: number, taskConcurrency: number, minMessageLifetime: number, computePoolSize: number|null }} opts
   */
  constructor (opts) {
    this.opts = opts
    /** @type {Array<any>} */
    this.servers = []
    /** @type {Array<any>} */
    this.workers = []
    /** @type {Array<number>} */
    this.ports = []
    this.redis = createClient({ url: config.dbs.redis })
    this.sql = postgres(config.dbs.postgres, { connect_timeout: 60 })
  }

  /**
   * @param {'server'|'worker'} role
   * @param {number} index
   */
  _spawn (role, index) {
    const port = config.hub.basePort + index
    const settings = {
      role,
      port,
      dbs: config.dbs,
      sampleIntervalMs: config.run.sampleIntervalMs,
      hub: {
        taskDebounce: this.opts.taskDebounce,
        minMessageLifetime: this.opts.minMessageLifetime,
        cacheTtl: config.hub.cacheTtl,
        taskConcurrency: this.opts.taskConcurrency,
        computePoolSize: this.opts.computePoolSize
      }
    }
    const child = fork(hubEntry, [JSON.stringify(settings)], {
      execArgv: ['--expose-gc', '--max-old-space-size=8192'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    })
    return { child, port }
  }

  async start () {
    await this.redis.connect()
    await this.reset()
    /** @type {Array<Promise<any>>} */
    const ready = []
    for (let i = 0; i < this.opts.servers; i++) {
      const { child, port } = this._spawn('server', i)
      this.servers.push(child)
      this.ports.push(port)
      ready.push(request(child, { t: 'noop' }, 'ready'))
    }
    for (let i = 0; i < this.opts.workers; i++) {
      const { child } = this._spawn('worker', 100 + i)
      this.workers.push(child)
      ready.push(request(child, { t: 'noop' }, 'ready'))
    }
    await promise.all(ready)
    return this
  }

  /** Every hub process this cluster runs. */
  get all () { return [...this.servers, ...this.workers] }

  /**
   * Wipe every key this suite owns, plus the persisted rows. Run before each
   * cluster boot so a benchmark never inherits another one's backlog.
   */
  async reset () {
    const prefix = config.dbs.redisPrefix
    for (const pattern of [`${prefix}:room:*`, `${prefix}:quarantine_room:*`, `${prefix}:cache:*`]) {
      const keys = await this.redis.keys(pattern)
      if (keys.length > 0) await this.redis.del(keys)
    }
    await this.redis.del(`${prefix}:compaction_disabled`)
    try {
      await this.redis.multi()
        .xGroupDestroy(`${prefix}:worker`, `${prefix}:worker`)
        .xTrim(`${prefix}:worker`, 'MAXLEN', 0)
        .xGroupCreate(`${prefix}:worker`, `${prefix}:worker`, '0', { MKSTREAM: true })
        .exec()
    } catch (_) {}
    const exists = await this.sql`SELECT EXISTS (SELECT FROM pg_tables WHERE tablename = 'yhub_ydoc_v1')`
    if (exists?.[0]?.exists) await this.sql`DELETE FROM yhub_ydoc_v1 WHERE org = ${config.hub.org}`
    await this.resetS3()
  }

  /**
   * Delete every S3 object this suite has ever written.
   *
   * Dropping the Postgres rows orphans the blobs rather than deleting them, and
   * a full run writes several GB — without this the bucket grows without bound
   * until the storage backend starts refusing writes, at which point compaction
   * fails silently and every Y5/Y6 number is wrong. Scoped to `config.hub.org`,
   * so it never touches the test suite's or anyone else's objects.
   */
  async resetS3 () {
    const { Client } = await import('minio')
    const s3 = new Client(config.dbs.s3)
    for (const prefix of ['id:ydoc:v1', 'id:contentmap:v1', 'id:contentids:v1']) {
      /** @type {Array<string>} */
      const names = []
      await new Promise((resolve, reject) => {
        const stream = s3.listObjectsV2(config.dbs.s3.bucket, `${prefix}/${config.hub.org}/`, true)
        stream.on('data', /** @param {any} o */ o => o.name && names.push(o.name))
        stream.on('end', resolve)
        stream.on('error', reject)
      })
      if (names.length > 0) await s3.removeObjects(config.dbs.s3.bucket, names)
    }
  }

  /**
   * Drop the API response cache. It is keyed by query params and is not
   * doc-version aware, so without this a repeated read measures a Redis GET
   * instead of the work being benchmarked.
   */
  async flushCache () {
    const keys = await this.redis.keys(`${config.dbs.redisPrefix}:cache:*`)
    if (keys.length > 0) await this.redis.del(keys)
  }

  /** Reset every process's counters and peak-RSS watermark. */
  async mark () {
    await promise.all(this.all.map(c => request(c, { t: 'mark' }, 'marked')))
  }

  /**
   * @return {Promise<{ server: ReturnType<sumProcessMetrics>, worker: ReturnType<sumProcessMetrics>, tasks: Array<{durationMs: number, error: boolean}>, compactions: Array<{gcBytes: number, nongcBytes: number, contentmapBytes: number}> }>}
   */
  async collect () {
    const server = await promise.all(this.servers.map(c => request(c, { t: 'collect' }, 'metrics').then(m => m.data)))
    const worker = await promise.all(this.workers.map(c => request(c, { t: 'collect' }, 'metrics').then(m => m.data)))
    const tasks = worker.flatMap(/** @param {any} w */ w => w.tasks)
    const failed = tasks.filter(/** @param {any} t */ t => t.error).length
    // A failing compaction (a full S3 backend is the usual cause) leaves the
    // room uncompacted and re-triggers forever, so every downstream number is
    // wrong. Shout about it, and record it so the written report carries the
    // caveat too — a warning that only ever reached the console would let a
    // committed RESULTS.md present broken rows as measurements.
    if (failed > 0) {
      taskFailures += failed
      console.warn(`\n  \x1b[31m⚠ ${failed}/${tasks.length} compaction tasks FAILED — run with BENCH_DEBUG=1 to see why. Results below are not trustworthy.\x1b[0m`)
    }
    return {
      server: sumProcessMetrics(server),
      worker: sumProcessMetrics(worker),
      tasks,
      compactions: worker.flatMap(/** @param {any} w */ w => w.compactions)
    }
  }

  /**
   * `XLEN` of a room's stream. Growth over time means compaction is not keeping
   * up, and every sync is getting more expensive as a result.
   * @param {{ org?: string, docid: string, branch?: string }} room
   */
  async streamLen (room) {
    const enc = encodeURIComponent
    const key = `${config.dbs.redisPrefix}:room:${enc(room.org ?? config.hub.org)}:${enc(room.docid)}:${enc(room.branch ?? 'main')}`
    try { return await this.redis.xLen(key) } catch (_) { return 0 }
  }

  /**
   * Rows in `yhub_ydoc_v1`, for one room or for the whole table. Every
   * uncompacted row of a room is an extra S3 GET on every sync of that room.
   * @param {{ org?: string, docid: string, branch?: string }} [room]
   */
  async pgRows (room) {
    const rows = room == null
      ? await this.sql`SELECT count(*)::int AS n FROM yhub_ydoc_v1`
      : await this.sql`SELECT count(*)::int AS n FROM yhub_ydoc_v1 WHERE org = ${room.org ?? config.hub.org} AND docid = ${room.docid} AND branch = ${room.branch ?? 'main'}`
    return rows[0].n
  }

  /** Number of compaction tasks still queued. */
  async pendingTasks () {
    try { return await this.redis.xLen(`${config.dbs.redisPrefix}:worker`) } catch (_) { return 0 }
  }

  /**
   * Block until a write has actually reached Redis. Without this, `drain()`
   * called right after a large `send()` sees an empty system and returns
   * immediately, and the compaction that follows is attributed to the next
   * benchmark instead of this one.
   *
   * @param {{ org?: string, docid: string, branch?: string }} room
   * @param {number} [timeoutMs]
   */
  async awaitWrite (room, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.streamLen(room) > 0 || await this.pgRows(room) > 0) return true
      await promise.wait(50)
    }
    return false
  }

  /**
   * Block until the worker has drained every pending task and no room stream is
   * left, i.e. the system is quiescent and measurements are not racing a
   * background compaction.
   * @param {number} [timeoutMs]
   */
  async drain (timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const pending = await this.pendingTasks()
      const active = (await this.redis.keys(`${config.dbs.redisPrefix}:room:*`)).length
      if (pending === 0 && active === 0) return true
      await promise.wait(200)
    }
    return false
  }

  async stop () {
    await promise.all(this.all.map(c => promise.create(resolve => {
      c.once('exit', resolve)
      c.send({ t: 'stop' })
      setTimeout(() => c.kill('SIGKILL'), 5000).unref()
    })))
    this.servers = []
    this.workers = []
    this.ports = []
    await this.redis.destroy()
    await this.sql.end({ timeout: 5 })
  }
}

/** @type {{ cluster: Cluster, key: string }|null} */
let running = null

/** Compaction tasks that errored since the last `takeTaskFailures()`. */
let taskFailures = 0

/**
 * Read and reset the compaction-failure count. The runner calls this after each
 * benchmark so the failure is attributed to the benchmark it happened in.
 */
export const takeTaskFailures = () => {
  const n = taskFailures
  taskFailures = 0
  return n
}

/**
 * Get a cluster with the given settings, reusing the running one when the
 * settings match.
 *
 * @param {Partial<{ servers: number, workers: number, taskDebounce: number, taskConcurrency: number, minMessageLifetime: number, computePoolSize: number|null }>} [overrides]
 * @return {Promise<Cluster>}
 */
export const getCluster = async (overrides = {}) => {
  const opts = {
    servers: config.hub.servers,
    workers: config.hub.workers,
    taskDebounce: config.hub.taskDebounce,
    minMessageLifetime: config.hub.minMessageLifetime,
    taskConcurrency: config.hub.taskConcurrency,
    computePoolSize: config.hub.computePoolSize,
    ...overrides
  }
  const key = JSON.stringify(opts)
  if (running != null && running.key === key) return running.cluster
  if (running != null) await running.cluster.stop()
  const cluster = await new Cluster(opts).start()
  running = { cluster, key }
  return cluster
}

export const stopCluster = async () => {
  if (running != null) await running.cluster.stop()
  running = null
}

/**
 * Reclaim the persisted documents of the benchmark that just finished.
 *
 * Benchmarks reuse a cluster when their settings match, so without this the
 * documents seeded by Y2.1 are still in S3 when Y6.6 runs. At 40 MB apiece that
 * is tens of GB over a full run, and a full backend makes compaction *fail*
 * rather than slow down. Every benchmark seeds its own uniquely-named rooms and
 * drains before returning, so nothing downstream depends on what is dropped.
 */
export const reclaimStorage = async () => {
  if (running == null) return
  try {
    await running.cluster.sql`DELETE FROM yhub_ydoc_v1 WHERE org = ${config.hub.org}`
    await running.cluster.resetS3()
  } catch (err) {
    console.warn(`  \x1b[2mstorage reclaim failed: ${/** @type {Error} */ (err).message}\x1b[0m`)
  }
}
