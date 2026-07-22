import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import * as time from 'lib0/time'
import * as s from 'lib0/schema'
import * as promise from 'lib0/promise'
import * as Y from '@y/y'
import * as math from 'lib0/math'
import { mergeUpdates } from './y-utils.js'
import { logger } from './logger.js'
import * as tel from './telemetry.js'

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
    groupMaxGap: s.$number,
    groupMaxDuration: s.$number
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
 * Context threaded through compute tasks — `room` for logging, `span` as the telemetry parent.
 *
 * @typedef {{ room?: import('./types.js').Room, span?: import('./telemetry.js').Span? }} ComputeCtx
 */

/**
 * Start a compute-task span under the ctx parent (or as a record root).
 *
 * @param {ComputePool} pool
 * @param {ComputeCtx} ctx
 * @param {ComputeTask['type']} taskType
 */
const startTaskSpan = (pool, ctx, taskType) => {
  const span = ctx.span != null ? ctx.span.span('yhub.compute.task') : pool.record.span('yhub.compute.task')
  span.attr('task', taskType)
  ctx.room !== undefined && span.attr('room', ctx.room)
  return span
}

/**
 * Cheap per-task-type size attributes.
 *
 * @param {import('./telemetry.js').Span} span
 * @param {ComputeTask} task
 */
const setTaskAttrs = (span, task) => {
  switch (task.type) {
    case 'mergeUpdates': {
      let updateSize = 0
      for (let i = 0; i < task.updates.length; i++) {
        updateSize += task.updates[i].byteLength
      }
      span.attr('updates', task.updates.length).attr('updateSize', updateSize)
      task.prune !== undefined && span.attr('pruneSize', task.prune.byteLength)
      break
    }
    case 'computePruneSet':
      span.attr('contentmapSize', task.contentmapBin.byteLength)
      break
    case 'computeStateVector':
      span.attr('updateSize', task.update.byteLength)
      break
    case 'patchYdoc':
      span.attr('updateSize', task.update.byteLength).attr('docSize', task.currentDoc.byteLength)
      break
    default: // changeset | activity | rollback
      span.attr('docSize', task.nongcDoc.byteLength).attr('contentmapSize', task.contentmapBin.byteLength)
  }
}

/**
 * Result bytes of a completed task — object results (patchYdoc/rollback) count their
 * update + contentmap.
 *
 * @param {any} result
 * @returns {number | undefined}
 */
const resultSize = result => result == null ? undefined : (result.byteLength ?? (result.update?.byteLength ?? 0) + (result.contentmap?.byteLength ?? 0))

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
     * @type {ComputeCtx?}
     */
    this._logContext = null
    /**
     * @type {import('./telemetry.js').Span?}
     */
    this._span = null
    this.worker.on('message', (/** @type {{ result: any, telemetry: { origin: number, updates: Array<import('./telemetry.js').SpanUpdate> } }} */ { result, telemetry }) => {
      const resolve = this._cbResolve
      const span = this._span
      if (span !== null) {
        const rs = resultSize(result)
        rs !== undefined && span.attr('resultSize', rs)
        // append the worker-side phase spans, rebasing their offsets onto this record's
        // origin. Both origins are Date.now-derived, so cross-thread alignment is ~1ms;
        // durations (offset diffs within one worker batch) stay exact.
        const record = span.record
        const delta = telemetry.origin - record.origin
        telemetry.updates.forEach(u => {
          u.type !== 'update_span' && (u.time = math.round(u.time + delta))
          record.add(u)
        })
        span.end()
        this._span = null
      }
      this._logContext = null
      finishWorker(this)
      resolve?.(result)
      drain(pool)
    })
    this.worker.on('error', (err) => {
      log.error({ err, room: this._logContext?.room }, 'worker failed')
      this._span?.end(err)
      this._span = null
      this._logContext = null
      const reject = this._cbReject
      this.isDead = true
      finishWorker(this)
      reject?.(err)
      drain(pool)
    })
    this.worker.on('exit', () => {
      this.isDead = true
      this._logContext = null
    })
  }

  /**
   * @param {ComputeTask} task
   * @param {Array<ArrayBuffer>} transferList
   * @param {ComputeCtx} logContext
   * @param {import('./telemetry.js').Span} span
   * @param {(value: any) => void} resolve
   * @param {(reason: any) => void} reject
   */
  run (task, transferList, logContext, span, resolve, reject) {
    this.isComputing = true
    this.taskStart = time.getUnixTime()
    this.lastUsed = this.taskStart
    this._cbResolve = resolve
    this._cbReject = reject
    this._logContext = logContext
    this._span = span
    span.attr('queueMs', span.elapsed() / 1e6)
    this.worker.postMessage({ task, spanId: span.id }, transferList)
  }

  terminate () {
    const err = new Error('Worker terminated')
    const span = this._span
    const reject = this._cbReject
    // clear all worker state before running callbacks — code that re-enters the pool
    // must see this worker as dead, not re-terminate it
    this._span = null
    this.isDead = true
    finishWorker(this)
    span?.end(err)
    reject?.(err)
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
    let w = pool.workers[i]
    if (w.isComputing && now - w.taskStart > maxTaskDurationMs) {
      log.warn({ workerIndex: i, taskDurationMs: now - w.taskStart }, 'terminating worker that exceeded max task duration')
      w.terminate()
      // defensive re-read: terminate must never act on a stale slot if a future change
      // lets callbacks re-enter drain synchronously (today reject/flush are async)
      w = pool.workers[i]
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
    const task = /** @type {{ task: ComputeTask, transferList: ArrayBuffer[], logContext: ComputeCtx, span: import('./telemetry.js').Span, resolve: (value: any) => void, reject: (reason: any) => void }} */ (pool.queue.shift())
    worker.run(task.task, task.transferList, task.logContext, task.span, task.resolve, task.reject)
  }
}

/**
 * @param {{ poolSize?: number, record?: import('./telemetry.js').Record }} [opts]
 */
export const createComputePool = (opts = {}) => {
  const poolSize = opts.poolSize ?? math.max(1, cpus().length - 1)
  return new ComputePool(poolSize, opts.record ?? tel.createRecord({ discard: true }))
}

class ComputePool {
  /**
   * @param {number} maxPoolSize
   * @param {import('./telemetry.js').Record} record
   */
  constructor (maxPoolSize, record) {
    this.maxPoolSize = maxPoolSize
    this.record = record
    /**
     * @type {Array<ComputeWorker>}
     */
    this.workers = []
    /**
     * @type {Array<{ task: ComputeTask, transferList: ArrayBuffer[], logContext: ComputeCtx, span: import('./telemetry.js').Span, resolve: (value: any) => void, reject: (reason: any) => void }>}
     */
    this.queue = []
  }

  /**
   * @param {ComputeTask} task
   * @param {Array<ArrayBuffer>} transferList
   * @param {ComputeCtx} logContext
   * @returns {Promise<any>}
   */
  run (task, transferList, logContext) {
    $computeTask.expect(task)
    // the span starts at enqueue, so its duration includes queue-wait (stamped as queueMs
    // at dispatch). `input` exposes the raw task for debug capture — only when the inputs
    // are structured-clone copied (empty transferList), never as detached buffers.
    const span = startTaskSpan(this, logContext, task.type)
    setTaskAttrs(span, task)
    transferList.length === 0 && span.attr('input', () => task)
    return promise.create((resolve, reject) => {
      this.queue.push({ task, transferList, logContext, span, resolve, reject })
      if (this.queue.length > 1) {
        log.debug({ taskType: task.type, queueDepth: this.queue.length }, 'task queued, no free worker')
      }
      drain(this)
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
   * @param {ComputeCtx} logContext
   * @param {Uint8Array<ArrayBuffer>} [prune]
   * @returns {Promise<Uint8Array<ArrayBuffer>>}
   */
  mergeUpdates (gc, updates, logContext = {}, prune) {
    let totalSize = 0
    for (let i = 0; i < updates.length; i++) {
      totalSize += updates[i].byteLength
    }
    if (totalSize <= 5120 || updates.length <= 1) {
      const span = startTaskSpan(this, logContext, 'mergeUpdates')
      span.attr('inline', true).attr('updates', updates.length).attr('updateSize', totalSize)
      prune !== undefined && span.attr('pruneSize', prune.byteLength)
      span.attr('input', () => ({ type: 'mergeUpdates', gc, updates, prune }))
      try {
        const res = mergeUpdates(gc, updates, prune)
        span.attr('resultSize', res.byteLength).end()
        return promise.resolveWith(res)
      } catch (err) {
        span.end(err)
        throw err
      }
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
   * @param {ComputeCtx} [logContext]
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
   * @param {ComputeCtx} logContext
   * @returns {Promise<Uint8Array<ArrayBuffer>>}
   */
  computeStateVector (update, logContext = {}) {
    if (update.byteLength < 512 * 1024) {
      const span = startTaskSpan(this, logContext, 'computeStateVector')
      span.attr('inline', true).attr('updateSize', update.byteLength)
      span.attr('input', () => ({ type: 'computeStateVector', update }))
      try {
        const res = Y.encodeStateVectorFromUpdate(update)
        span.attr('resultSize', res.byteLength).end()
        return promise.resolveWith(res)
      } catch (err) {
        span.end(err)
        throw err
      }
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
   * @param {ComputeCtx} [logContext]
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
   * @param {number} opts.groupMaxGap
   * @param {number} opts.groupMaxDuration
   * @param {ComputeCtx} [logContext]
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
   * @param {ComputeCtx} [logContext]
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
   * @param {ComputeCtx} [logContext]
   * @returns {Promise<{ update: Uint8Array<ArrayBuffer>, contentmap: Uint8Array<ArrayBuffer> }>}
   */
  rollback (opts, logContext = {}) {
    return this.run({ type: 'rollback', ...opts }, [], logContext)
  }

  async destroy () {
    // flush queued-but-undispatched tasks with the same semantics terminate() applies to
    // the in-flight task — their spans started at enqueue and must end
    const err = new Error('Worker terminated')
    while (this.queue.length > 0) {
      const e = /** @type {NonNullable<ReturnType<ComputePool['queue']['shift']>>} */ (this.queue.shift())
      e.span.end(err)
      e.reject(err)
    }
    await promise.all(this.workers.map(w => w.terminate()))
  }
}
