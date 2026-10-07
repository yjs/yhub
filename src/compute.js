import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import * as s from 'lib0/schema'
import * as promise from 'lib0/promise'
import * as Y from '@y/y'
import * as math from 'lib0/math'
import { mergeUpdates } from './y-utils.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'compute' })

const workerUrl = new URL('./compute-worker.js', import.meta.url)

const $computeTask = s.$union(
  s.$object({
    type: s.$literal('mergeUpdates'),
    gc: s.$boolean,
    updates: s.$array(s.$uint8Array),
    prune: s.$uint8Array.optional
  }),
  s.$object({
    type: s.$literal('computePruneSet'),
    contentmapBin: s.$uint8Array,
    from: s.$number.optional,
    to: s.$number.optional,
    by: s.$string.optional,
    contentIds: s.$uint8Array.optional,
    withCustomAttributions: s.$array(s.$object({ k: s.$string, v: s.$string })).nullable.optional
  }),
  s.$object({
    type: s.$literal('computeStateVector'),
    update: s.$uint8Array
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
    includeYdoc: s.$boolean,
    includeAttributions: s.$boolean,
    limit: s.$number,
    reverse: s.$boolean,
    group: s.$boolean,
    groupByUser: s.$boolean,
    groupMaxGap: s.$number,
    groupMaxDuration: s.$number,
    groupExclude: s.$array(s.$string),
    // named versions in the window, sorted by `t`. Only `t` is checked: the rows were validated
    // when they were written, and checking the whole shape here would fail reads of rows that a
    // newer release wrote (a rolling deploy, a downgrade)
    versions: s.$array(/** @type {s.Schema<import('./types.js').Version>} */ (s.$object({ t: s.$number }))).optional
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
 * @typedef {{ task: ComputeTask, transferList: ArrayBuffer[], logContext: Object<string, any>, resolve: (value: any) => void, reject: (reason: any) => void, queueTimeout: NodeJS.Timeout? }} QueuedTask
 */

/**
 * `ComputePool.run` rejects with an error whose `code` is `'COMPUTE_QUEUE_FULL'` when
 * `computePool.maxQueue` tasks are already waiting for a thread. Transient: the rest layer answers it with 503, the websocket
 * initial sync closes with 1013.
 *
 * @param {any} err
 */
export const isComputeQueueFull = err => err?.code === 'COMPUTE_QUEUE_FULL'

/**
 * @param {ComputeWorker} cw
 */
const finishWorker = (cw) => {
  cw.isComputing = false
  cw._cbResolve = null
  cw._cbReject = null
  cw._taskTimeout != null && clearTimeout(cw._taskTimeout)
  cw._taskTimeout = null
}

class ComputeWorker {
  /**
   * @param {ComputePool} pool
   */
  constructor (pool) {
    this.pool = pool
    // a thread that exceeds its resourceLimits dies on its own ('error', then 'exit' below).
    // Without them, every thread may grow to the main thread's heap limit - together they can
    // outgrow the container, whose OOM killer then ends the whole process
    this.worker = new Worker(workerUrl, { execArgv: [], resourceLimits: pool.resourceLimits })
    this.isComputing = false
    this.isDead = false
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
    /**
     * @type {NodeJS.Timeout?}
     */
    this._taskTimeout = null
    this.worker.on('message', (result) => {
      const resolve = this._cbResolve
      finishWorker(this)
      resolve?.(result)
      this._logContext = null
      drain(pool)
    })
    this.worker.on('error', (err) => {
      log.error({ err, ...this._logContext }, 'worker failed')
      const reject = this._cbReject
      this.isDead = true
      finishWorker(this)
      reject?.(err)
      this._logContext = null
      drain(pool)
    })
    this.worker.on('exit', () => {
      // a thread that exits without emitting 'error' would otherwise leave its task promise
      // unsettled until the taskTimeout above fires - settle it now instead, so the caller can
      // retry immediately. 'error' runs first when it fires and clears _cbReject.
      const reject = this._cbReject
      this.isDead = true
      finishWorker(this)
      reject?.(new Error('Worker exited'))
      this._logContext = null
      drain(pool)
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
    this._cbResolve = resolve
    this._cbReject = reject
    this._logContext = logContext
    // a compute task can't be cancelled cooperatively - a merge that doesn't come back (a
    // pathological document, a thread thrashing itself to death on gc) is only stoppable by
    // killing the thread. `terminate` interrupts synchronous code too, and rejects the task, so
    // the caller retries instead of waiting forever.
    this._taskTimeout = setTimeout(() => {
      log.error({ taskType: task.type, taskTimeout: this.pool.taskTimeout, ...logContext }, 'compute task exceeded taskTimeout, terminating worker thread')
      this.terminate()
    }, this.pool.taskTimeout)
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

/**
 * @param {ComputePool} pool
 * @returns {ComputeWorker | undefined}
 */
const getFreeWorker = (pool) => {
  for (let i = 0; i < pool.workers.length; i++) {
    const w = pool.workers[i]
    if (w.isDead) {
      log.info({ workerIndex: i }, 'replacing dead worker')
      pool.workers[i] = new ComputeWorker(pool)
      return pool.workers[i]
    }
    if (!w.isComputing) return w
  }
  if (pool.workers.length < pool.maxThreads) {
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
    const task = /** @type {QueuedTask} */ (pool.queue.shift())
    task.queueTimeout != null && clearTimeout(task.queueTimeout)
    worker.run(task.task, task.transferList, task.logContext, task.resolve, task.reject)
  }
}

/**
 * @param {import('./types.js').YHubConfig['computePool']} [opts]
 */
export const createComputePool = (opts = {}) => {
  // V8 applies these flags to every thread of the process, over the thread's own limit
  if (opts.resourceLimits?.maxOldGenerationSizeMb != null && [...process.execArgv, process.env.NODE_OPTIONS ?? ''].some(arg => /--max[-_](old[-_]space|heap)[-_]size/.test(arg))) {
    log.warn({ maxOldGenerationSizeMb: opts.resourceLimits.maxOldGenerationSizeMb }, 'computePool.resourceLimits.maxOldGenerationSizeMb has no effect: the process runs with --max-old-space-size or --max-heap-size')
  }
  return new ComputePool(opts.maxThreads ?? math.max(1, cpus().length - 1), opts.maxQueue ?? Infinity, opts.taskTimeout ?? 30 * 60 * 1000, opts.resourceLimits)
}

class ComputePool {
  /**
   * @param {number} maxThreads
   * @param {number} maxQueue tasks that may wait for a thread; `run` rejects any further task
   * @param {number} taskTimeout ms after which a running task's worker thread is killed, and a queued task is rejected
   * @param {import('node:worker_threads').ResourceLimits} [resourceLimits] of each worker thread
   */
  constructor (maxThreads, maxQueue, taskTimeout, resourceLimits) {
    this.maxThreads = maxThreads
    this.maxQueue = maxQueue
    this.taskTimeout = taskTimeout
    this.resourceLimits = resourceLimits
    /**
     * @type {Array<ComputeWorker>}
     */
    this.workers = []
    /**
     * @type {Array<QueuedTask>}
     */
    this.queue = []
    this.isDestroyed = false
  }

  /**
   * @returns {{ queued: number, busy: number, workers: number }} tasks waiting for a thread,
   * threads computing a task, and live threads
   */
  stats () {
    return {
      queued: this.queue.length,
      busy: this.workers.filter(w => w.isComputing).length,
      workers: this.workers.filter(w => !w.isDead).length
    }
  }

  /**
   * @param {ComputeTask} task
   * @param {Array<ArrayBuffer>} transferList
   * @param {Object<string, any>} logContext
   * @returns {Promise<any>}
   */
  run (task, transferList, logContext) {
    $computeTask.expect(task)
    // a new thread would keep the process alive after `destroy`
    if (this.isDestroyed) return promise.reject(new Error('compute pool destroyed'))
    return promise.create((resolve, reject) => {
      /**
       * @type {QueuedTask}
       */
      const entry = { task, transferList, logContext, resolve, reject, queueTimeout: null }
      this.queue.push(entry)
      drain(this)
      if (this.queue.length === 0) return
      // every queued entry pins its task's buffers - full documents - until a thread takes it
      if (this.queue.length > this.maxQueue) {
        this.queue.pop()
        log.warn({ taskType: task.type, maxQueue: this.maxQueue, ...logContext }, 'compute queue full, rejecting task')
        reject(Object.assign(new Error('compute queue full'), { code: 'COMPUTE_QUEUE_FULL' }))
        return
      }
      log.debug({ taskType: task.type, queueDepth: this.queue.length }, 'task queued, no free worker')
      // the caller would otherwise wait unboundedly behind tasks that each may run for taskTimeout
      entry.queueTimeout = setTimeout(() => {
        this.queue.splice(this.queue.indexOf(entry), 1)
        log.error({ taskType: task.type, taskTimeout: this.taskTimeout, ...logContext }, 'compute task waited taskTimeout for a worker thread, rejecting it')
        reject(new Error('compute task exceeded taskTimeout while queued'))
      }, this.taskTimeout)
    })
  }

  /**
   * Merges updates synchronously if there are 0-1 updates or the total size
   * is <= 5kb. Otherwise offloads to a worker thread. When `gc` is `true`,
   * deleted content is garbage-collected.
   *
   * When `prune` (a serialized `IdSet`) is given, that content is
   * garbage-collected after merging (used to prune churned history).
   *
   * @param {boolean} gc
   * @param {Array<Uint8Array<ArrayBuffer>>} updates
   * @param {Object<string, any>} logContext
   * @param {Uint8Array<ArrayBuffer>} [prune]
   * @returns {Promise<Uint8Array<ArrayBuffer>>}
   */
  mergeUpdates (gc, updates, logContext = {}, prune) {
    let totalSize = 0
    for (let i = 0; i < updates.length; i++) {
      totalSize += updates[i].byteLength
    }
    if (totalSize <= 5120 || updates.length <= 1) {
      return promise.resolveWith(mergeUpdates(gc, updates, prune))
    }
    return this.run({ type: 'mergeUpdates', gc, updates, prune }, [], logContext)
  }

  /**
   * Computes the prune set for a time/author/content range: the IDs that were
   * both inserted and deleted within the filtered range (`intersectSets` of the
   * in-range insertions and deletions). Returns the serialized `IdSet`, or
   * `null` if nothing matches.
   *
   * @param {object} opts
   * @param {Uint8Array<ArrayBuffer>} opts.contentmapBin
   * @param {number} [opts.from]
   * @param {number} [opts.to]
   * @param {string} [opts.by]
   * @param {Uint8Array<ArrayBuffer>} [opts.contentIds]
   * @param {Array<{k: string, v: string}>|null} [opts.withCustomAttributions]
   * @param {Object<string, any>} [logContext]
   * @returns {Promise<Uint8Array<ArrayBuffer>|null>}
   */
  computePruneSet (opts, logContext = {}) {
    return this.run({ type: 'computePruneSet', ...opts }, [], logContext)
  }

  /**
   * Computes the state vector from an encoded update.
   *
   * `encodeStateVectorFromUpdate` is a full linear scan of the update binary
   * (measured at ~30-40 MB/s), so it runs synchronously for updates < 512kb
   * (under ~15ms). Larger updates are offloaded to a worker. The buffer can't
   * be transferred (the caller reuses it for syncStep2), so the main thread
   * still pays a structured-clone copy on postMessage — but that copy is
   * ~32x cheaper than the scan (e.g. ~0.8ms vs ~25ms for a 1mb update).
   *
   * @param {Uint8Array<ArrayBuffer>} update
   * @param {Object<string, any>} logContext
   * @returns {Promise<Uint8Array<ArrayBuffer>>}
   */
  computeStateVector (update, logContext = {}) {
    if (update.byteLength < 512 * 1024) {
      return promise.resolveWith(Y.encodeStateVectorFromUpdate(update))
    }
    return this.run({ type: 'computeStateVector', update }, [], logContext)
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
   * @param {boolean} opts.includeYdoc
   * @param {boolean} opts.includeAttributions
   * @param {number} opts.limit
   * @param {boolean} opts.reverse
   * @param {boolean} opts.group
   * @param {boolean} opts.groupByUser
   * @param {number} opts.groupMaxGap
   * @param {number} opts.groupMaxDuration
   * @param {Array<string>} opts.groupExclude
   * @param {Array<import('./types.js').Version>} [opts.versions] named versions in [from, to], sorted by `t` (default: none)
   * @param {Object<string, any>} [logContext]
   * @returns {Promise<Uint8Array<ArrayBuffer>>}
   */
  activity (opts, logContext = {}) {
    return this.run({ type: 'activity', ...opts }, [], logContext)
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

  /**
   * Terminate the worker threads. Running and queued tasks are rejected, and so is every task
   * submitted afterwards.
   */
  async destroy () {
    this.isDestroyed = true
    // emptied first: each terminated thread's `exit` drains the queue, which would spawn a new one
    this.queue.splice(0).forEach(task => {
      task.queueTimeout != null && clearTimeout(task.queueTimeout)
      task.reject(new Error('compute pool destroyed'))
    })
    await promise.all(this.workers.map(w => w.terminate()))
  }
}
