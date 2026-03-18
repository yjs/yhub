import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import * as time from 'lib0/time'
import * as s from 'lib0/schema'
import * as promise from 'lib0/promise'
import * as Y from '@y/y'
import * as math from 'lib0/math'
import { logger } from './logger.js'

const log = logger.child({ module: 'compute' })

const workerUrl = new URL('./compute-worker.js', import.meta.url)

const $computeTask = s.$union(
  s.$object({
    type: s.$literal('mergeUpdatesAndGc'),
    updates: s.$array(s.$uint8Array)
  }),
  s.$object({
    type: s.$literal('mergeUpdates'),
    updates: s.$array(s.$uint8Array)
  }),
  s.$object({
    type: s.$literal('changeset'),
    nongcDoc: s.$uint8Array,
    contentmapBin: s.$uint8Array,
    from: s.$number.nullable,
    to: s.$number.nullable,
    by: s.$string,
    withCustomAttributions: s.$array(s.$object({ k: s.$string, v: s.$string })).nullable,
    includeYdoc: s.$boolean,
    includeDelta: s.$boolean,
    includeAttributions: s.$boolean
  }),
  s.$object({
    type: s.$literal('activity'),
    nongcDoc: s.$uint8Array,
    contentmapBin: s.$uint8Array,
    from: s.$number,
    to: s.$number,
    by: s.$string,
    contentIds: s.$uint8Array.optional,
    withCustomAttributions: s.$array(s.$object({ k: s.$string, v: s.$string })).nullable,
    includeCustomAttributions: s.$boolean,
    includeDelta: s.$boolean,
    limit: s.$number,
    reverse: s.$boolean,
    group: s.$boolean
  }),
  s.$object({
    type: s.$literal('patchYdoc'),
    update: s.$uint8Array,
    currentDoc: s.$uint8Array,
    userid: s.$string,
    customAttributions: s.$array(s.$object({ k: s.$string, v: s.$string }))
  }),
  s.$object({
    type: s.$literal('rollback'),
    nongcDoc: s.$uint8Array,
    contentmapBin: s.$uint8Array,
    from: s.$number.optional,
    to: s.$number.optional,
    by: s.$string.optional,
    contentIds: s.$uint8Array.optional,
    withCustomAttributions: s.$array(s.$object({ k: s.$string, v: s.$string })).nullable.optional,
    userid: s.$string,
    customAttributions: s.$array(s.$object({ k: s.$string, v: s.$string }))
  })
)

/**
 * @typedef {s.Unwrap<$computeTask>} ComputeTask
 */

/**
 * @param {ComputeWorker} cw
 */
const finishWorker = (cw) => {
  cw.isComputing = false
  cw.taskEnd = time.getUnixTime()
  cw.lastUsed = cw.taskEnd
  cw._cbResolve = null
  cw._cbReject = null
}

class ComputeWorker {
  /**
   * @param {ComputePool} pool
   */
  constructor (pool) {
    this.pool = pool
    this.worker = new Worker(workerUrl, { execArgv: [] })
    this.isComputing = false
    this.isDead = false
    /**
     * Unix time in ms when the current task started.
     */
    this.taskStart = 0
    /**
     * Unix time in ms when the current task ended.
     */
    this.taskEnd = 0
    /**
     * Unix time in ms when the worker was last used.
     */
    this.lastUsed = 0
    /**
     * @type {((value: any) => void) | null}
     */
    this._cbResolve = null
    /**
     * @type {((reason: any) => void) | null}
     */
    this._cbReject = null
    /**
     * @type {Object<string, any>?}
     */
    this._logContext = null
    this.worker.on('message', (result) => {
      const resolve = this._cbResolve
      finishWorker(this)
      resolve?.(result)
      drain(pool)
      this._logContext = null
    })
    this.worker.on('error', (err) => {
      log.error({ err, ...this._logContext }, 'worker failed')
      const reject = this._cbReject
      this.isDead = true
      finishWorker(this)
      reject?.(err)
      drain(pool)
      this._logContext = null
    })
    this.worker.on('exit', () => {
      this.isDead = true
      this._logContext = null
    })
  }

  /**
   * @param {ComputeTask} task
   * @param {Array<ArrayBuffer>} transferList
   * @param {Object<string, any>} logContext
   * @param {(value: any) => void} resolve
   * @param {(reason: any) => void} reject
   */
  run (task, transferList, logContext, resolve, reject) {
    this.isComputing = true
    this.taskStart = time.getUnixTime()
    this.lastUsed = this.taskStart
    this._cbResolve = resolve
    this._cbReject = reject
    this._logContext = logContext
    this.worker.postMessage(task, transferList)
  }

  terminate () {
    const reject = this._cbReject
    finishWorker(this)
    reject?.(new Error('Worker terminated'))
    this.isDead = true
    return this.worker.terminate()
  }
}

const maxTaskDurationMs = 30 * 60 * 1000 // 30 minutes

/**
 * @param {ComputePool} pool
 * @returns {ComputeWorker | undefined}
 */
const getFreeWorker = (pool) => {
  const now = time.getUnixTime()
  for (let i = 0; i < pool.workers.length; i++) {
    const w = pool.workers[i]
    if (w.isComputing && now - w.taskStart > maxTaskDurationMs) {
      log.warn({ workerIndex: i, taskDurationMs: now - w.taskStart }, 'terminating worker that exceeded max task duration')
      w.terminate()
    }
    if (w.isDead) {
      log.info({ workerIndex: i }, 'replacing dead worker')
      pool.workers[i] = new ComputeWorker(pool)
      return pool.workers[i]
    }
    if (!w.isComputing) return w
  }
  if (pool.workers.length < pool.maxPoolSize) {
    const cw = new ComputeWorker(pool)
    pool.workers.push(cw)
    return cw
  }
}

/**
 * @param {ComputePool} pool
 */
const drain = (pool) => {
  while (pool.queue.length > 0) {
    const worker = getFreeWorker(pool)
    if (!worker) break
    const task = /** @type {{ task: ComputeTask, transferList: ArrayBuffer[], logContext: Object<string, any>, resolve: (value: any) => void, reject: (reason: any) => void }} */ (pool.queue.shift())
    worker.run(task.task, task.transferList, task.logContext, task.resolve, task.reject)
  }
}

/**
 * @param {{ poolSize?: number }} [opts]
 */
export const createComputePool = (opts = {}) => {
  const poolSize = opts.poolSize ?? math.max(1, cpus().length - 1)
  return new ComputePool(poolSize)
}

class ComputePool {
  /**
   * @param {number} maxPoolSize
   */
  constructor (maxPoolSize) {
    this.maxPoolSize = maxPoolSize
    /**
     * @type {Array<ComputeWorker>}
     */
    this.workers = []
    /**
     * @type {Array<{ task: ComputeTask, transferList: ArrayBuffer[], logContext: Object<string, any>, resolve: (value: any) => void, reject: (reason: any) => void }>}
     */
    this.queue = []
  }

  /**
   * @param {ComputeTask} task
   * @param {Array<ArrayBuffer>} transferList
   * @param {Object<string, any>} logContext
   * @returns {Promise<any>}
   */
  run (task, transferList, logContext) {
    $computeTask.expect(task)
    return promise.create((resolve, reject) => {
      this.queue.push({ task, transferList, logContext, resolve, reject })
      if (this.queue.length > 1) {
        log.debug({ taskType: task.type, queueDepth: this.queue.length }, 'task queued, no free worker')
      }
      drain(this)
    })
  }

  /**
   * @param {Array<Uint8Array<ArrayBuffer>>} updates
   * @param {Object<string, any>} logContext
   * @returns {Promise<Uint8Array<ArrayBuffer>>}
   */
  mergeUpdatesAndGc (updates, logContext = {}) {
    return this.run({ type: 'mergeUpdatesAndGc', updates }, [], logContext)
  }

  /**
   * Merges updates synchronously if there are 0-1 updates or the total size
   * is <= 5kb. Otherwise offloads to a worker thread.
   *
   * @param {Array<Uint8Array<ArrayBuffer>>} updates
   * @param {Object<string, any>} logContext
   * @returns {Promise<Uint8Array<ArrayBuffer>>}
   */
  mergeUpdates (updates, logContext = {}) {
    let totalSize = 0
    for (let i = 0; i < updates.length; i++) {
      totalSize += updates[i].byteLength
    }
    if (totalSize <= 5120 || updates.length <= 1) {
      return promise.resolveWith(Y.mergeUpdates(updates))
    }
    return this.run({ type: 'mergeUpdates', updates }, [], logContext)
  }

  /**
   * @param {object} opts
   * @param {Uint8Array<ArrayBuffer>} opts.nongcDoc
   * @param {Uint8Array<ArrayBuffer>} opts.contentmapBin
   * @param {number|null} opts.from
   * @param {number|null} opts.to
   * @param {string} opts.by
   * @param {Array<{k: string, v: string}>|null} opts.withCustomAttributions
   * @param {boolean} opts.includeYdoc
   * @param {boolean} opts.includeDelta
   * @param {boolean} opts.includeAttributions
   * @param {Object<string, any>} [logContext]
   * @returns {Promise<Uint8Array<ArrayBuffer>>}
   */
  changeset (opts, logContext = {}) {
    return this.run({ type: 'changeset', ...opts }, [], logContext)
  }

  /**
   * @param {object} opts
   * @param {Uint8Array<ArrayBuffer>} opts.nongcDoc
   * @param {Uint8Array<ArrayBuffer>} opts.contentmapBin
   * @param {number} opts.from
   * @param {number} opts.to
   * @param {string} opts.by
   * @param {Uint8Array<ArrayBuffer>} [opts.contentIds]
   * @param {Array<{k: string, v: string}>|null} opts.withCustomAttributions
   * @param {boolean} opts.includeCustomAttributions
   * @param {boolean} opts.includeDelta
   * @param {number} opts.limit
   * @param {boolean} opts.reverse
   * @param {boolean} opts.group
   * @param {Object<string, any>} [logContext]
   * @returns {Promise<Uint8Array<ArrayBuffer>>}
   */
  activity (opts, logContext = {}) {
    return this.run({ type: 'activity', ...opts }, [], logContext)
  }

  /**
   * @param {object} opts
   * @param {Uint8Array<ArrayBuffer>} opts.update
   * @param {Uint8Array<ArrayBuffer>} opts.currentDoc
   * @param {string} opts.userid
   * @param {Array<{k: string, v: string}>} opts.customAttributions
   * @param {Object<string, any>} [logContext]
   * @returns {Promise<{ update: Uint8Array<ArrayBuffer>, contentmap: Uint8Array<ArrayBuffer> } | null>}
   */
  patchYdoc (opts, logContext = {}) {
    return this.run({ type: 'patchYdoc', ...opts }, [], logContext)
  }

  /**
   * @param {object} opts
   * @param {Uint8Array<ArrayBuffer>} opts.nongcDoc
   * @param {Uint8Array<ArrayBuffer>} opts.contentmapBin
   * @param {number} [opts.from]
   * @param {number} [opts.to]
   * @param {string} [opts.by]
   * @param {Uint8Array<ArrayBuffer>} [opts.contentIds]
   * @param {Array<{k: string, v: string}>|null} [opts.withCustomAttributions]
   * @param {string} opts.userid
   * @param {Array<{k: string, v: string}>} opts.customAttributions
   * @param {Object<string, any>} [logContext]
   * @returns {Promise<{ update: Uint8Array<ArrayBuffer>, contentmap: Uint8Array<ArrayBuffer> }>}
   */
  rollback (opts, logContext = {}) {
    return this.run({ type: 'rollback', ...opts }, [], logContext)
  }

  async destroy () {
    await promise.all(this.workers.map(w => w.terminate()))
  }
}
