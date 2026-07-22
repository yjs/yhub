import * as t from 'lib0/testing'
import * as Y from '@y/y'
import * as object from 'lib0/object'
import * as promise from 'lib0/promise'
import { SpanStatusCode } from '@opentelemetry/api'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { createComputePool } from '../src/compute.js'
import * as tel from '../src/telemetry.js'
import { createTelemetry } from '../src/telemetry-hub.js'
import * as utils from './utils.js'

/**
 * @param {{ log?: 'debug'|'info'|false }} [opts]
 */
const createCollector = ({ log = false } = {}) => {
  /**
   * @type {Array<import('../src/telemetry.js').SpanUpdate>}
   */
  const updates = []
  const spanExporter = new InMemorySpanExporter()
  const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] })
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3600000 })
  const meterProvider = new MeterProvider({ readers: [metricReader] })
  const telemetry = /** @type {NonNullable<ReturnType<typeof createTelemetry>>} */ (createTelemetry({ tracerProvider, meterProvider, log, onUpdate: us => updates.push(...us) }))
  return { updates, spanExporter, metricReader, telemetry }
}

/**
 * Record flushes (and hence collector deliveries) are debounced via setTimeout.
 */
const flushed = () => promise.wait(10)

/**
 * Two updates large enough (> 5120 bytes total) to bypass the inline fast path.
 */
const createBigUpdates = () => {
  const doc1 = new Y.Doc()
  doc1.get('test').insert(0, 'a'.repeat(4000))
  const update1 = Y.encodeStateAsUpdate(doc1)
  const doc2 = new Y.Doc()
  Y.applyUpdate(doc2, update1)
  doc2.get('test').insert(4000, 'b'.repeat(4000))
  const update2 = Y.encodeStateAsUpdate(doc2)
  doc1.destroy()
  doc2.destroy()
  return { update1, update2 }
}

/**
 * Rollback task inputs (attributed two-user document), cribbed from computeWorker.tests.js.
 */
const createRollbackFixture = () => {
  const doc = new Y.Doc({ gc: false })
  doc.get('test').insert(0, 'hello')
  const update1 = Y.encodeStateAsUpdate(doc)
  const contentIds1 = Y.createContentIdsFromUpdate(update1)
  const contentmap1 = Y.createContentMapFromContentIds(
    contentIds1,
    [Y.createContentAttribute('insert', 'user1'), Y.createContentAttribute('insertAt', 1000)],
    [Y.createContentAttribute('delete', 'user1'), Y.createContentAttribute('deleteAt', 1000)]
  )
  doc.get('test').insert(5, ' world')
  const nongcDoc = Y.encodeStateAsUpdate(doc)
  const contentIds2 = Y.excludeContentIds(Y.createContentIdsFromUpdate(nongcDoc), contentIds1)
  const contentmap2 = Y.createContentMapFromContentIds(
    contentIds2,
    [Y.createContentAttribute('insert', 'user2'), Y.createContentAttribute('insertAt', 2000)],
    [Y.createContentAttribute('delete', 'user2'), Y.createContentAttribute('deleteAt', 2000)]
  )
  const contentmapBin = Y.encodeContentMap(Y.mergeContentMaps([contentmap1, contentmap2]))
  doc.destroy()
  return { nongcDoc, contentmapBin }
}

/**
 * Span lifecycle: start/update/end sequencing, attr coalescing, exact ns offsets, ids.
 *
 * @param {t.TestCase} _tc
 */
export const testRecordUpdates = async _tc => {
  const record = tel.createRecord()
  const s1 = record.span('a')
  s1.attr('x', 1)
  s1.attr('y', 2)
  const s2 = s1.span('b')
  s1.attr('z', 3)
  s2.end()
  s1.end(new Error('boom'))
  const us = record.drain()
  t.assert(record.updates.length === 0, 'drain empties the record')
  // [start a][update a x,y][start b][update a z][end b][update a error][end a]
  t.assert(us.length === 7)
  t.assert(us[0].type === 'start_span' && us[0].name === 'a' && us[0].parent === null && us[0].id === s1.id)
  t.assert(us[1].type === 'update_span' && us[1].attrs.length === 2, 'consecutive attrs coalesce into one update')
  t.assert(us[2].type === 'start_span' && us[2].parent === s1.id && us[2].id === s2.id)
  t.assert(us[3].type === 'update_span' && us[3].id === s1.id && us[3].attrs.length === 1, 'interleaved span breaks coalescing')
  t.assert(us[4].type === 'end_span' && us[4].id === s2.id && us[4].success === true && us[4].err === false)
  t.assert(us[5].type === 'update_span' && us[5].attrs[0][0] === 'error' && us[5].attrs[0][1].message === 'boom')
  t.assert(us[6].type === 'end_span' && us[6].id === s1.id && us[6].success === false && us[6].err === true)
  us.forEach(u => { u.type !== 'update_span' && t.assert(Number.isInteger(u.time) && u.time >= 0, 'times are exact integer offset-ns') })
  t.assert(/** @type {tel.EndSpan} */ (us[6]).time >= /** @type {tel.StartSpan} */ (us[0]).time)
  t.assert(s1.id !== s2.id && s1.id.split('-')[0] === s2.id.split('-')[0], 'prefix+counter ids')
  t.assert(Number.isInteger(record.origin) && record.origin > 1e18, 'epoch-ns origin')
}

/**
 * fn-form semantics: result passthrough, sync rethrow, async settle, rejection propagation.
 *
 * @param {t.TestCase} _tc
 */
export const testSpanFn = async _tc => {
  const record = tel.createRecord()
  const res = record.span('sync', span => {
    span.attr('k', 'v')
    return 42
  })
  t.assert(res === 42, 'fn result is returned')
  let threw = /** @type {any} */ (null)
  try {
    record.span('bad', () => {
      throw new Error('x')
    })
  } catch (e) {
    threw = e
  }
  t.assert(threw != null, 'sync throw is rethrown')
  const p = record.span('async', async () => {
    await promise.wait(3)
    return 'ok'
  })
  t.assert(await p === 'ok')
  let rejected = /** @type {any} */ (null)
  try {
    await record.span('rejects', async () => {
      throw new Error('r')
    })
  } catch (e) {
    rejected = e
  }
  t.assert(rejected != null, 'rejection propagates')
  const roots = tel.buildTree(record.drain())
  const byName = (/** @type {string} */ name) => /** @type {tel.SpanNode} */ (roots.find(n => n.name === name))
  t.assert(byName('sync').success && byName('sync').attributes.k === 'v')
  t.assert(byName('bad').err && byName('bad').attributes.error.message === 'x')
  t.assert(byName('async').success && byName('async').duration > 0, 'async span ended on settle')
  t.assert(byName('rejects').err && byName('rejects').attributes.error.message === 'r')
}

/**
 * Remote (string) parents and tree assembly.
 *
 * @param {t.TestCase} _tc
 */
export const testBuildTree = async _tc => {
  const record = tel.createRecord()
  const parent = record.span('p')
  const remote = record.span('r', undefined, parent.id)
  remote.end()
  parent.end()
  const open = record.span('open')
  open.attr('a', 1)
  const roots = tel.buildTree(record.drain())
  t.assert(roots.length === 2)
  t.assert(roots[0].name === 'p' && roots[0].children.length === 1 && roots[0].children[0].name === 'r')
  t.assert(roots[0].children[0].duration >= 0 && roots[0].duration >= roots[0].children[0].duration)
  t.assert(roots[1].name === 'open' && roots[1].duration === -1 && roots[1].attributes.a === 1, 'unended spans stay open')
}

/**
 * The wire format survives JSON and structuredClone unchanged (no symbols, no bigints).
 *
 * @param {t.TestCase} _tc
 */
export const testJsonRoundTrip = async _tc => {
  const record = tel.createRecord()
  record.span('a', span => {
    span.attr('n', 1).attr('s', 'x').attr('o', { nested: true })
    span.span('b', () => {})
  })
  const us = record.drain()
  t.compare(JSON.parse(JSON.stringify(us)), us)
  t.compare(structuredClone(us), us)
}

/**
 * A discarding record measures without accumulating — the disabled mode.
 *
 * @param {t.TestCase} _tc
 */
export const testDiscard = async _tc => {
  const record = tel.createRecord({ discard: true })
  const res = record.span('a', span => {
    span.attr('x', 1)
    return 1
  })
  t.assert(res === 1)
  t.assert(record.updates.length === 0)
}

/**
 * onFlush is debounced: many appends in one tick → one batch.
 *
 * @param {t.TestCase} _tc
 */
export const testOnFlushDebounce = async _tc => {
  /**
   * @type {Array<Array<import('../src/telemetry.js').SpanUpdate>>}
   */
  const batches = []
  const record = tel.createRecord({ onFlush: us => batches.push(us) })
  record.span('a', () => {})
  record.span('b', () => {})
  t.assert(batches.length === 0, 'flush is debounced')
  await flushed()
  t.assert(batches.length === 1 && batches[0].length === 4, 'one batch for one tick')
  record.span('c', () => {})
  await flushed()
  t.assert(batches.length === 2)
}

/**
 * Default pools discard telemetry; results are byte-identical to a collecting pool.
 *
 * @param {t.TestCase} _tc
 */
export const testDisabledPath = async _tc => {
  const { update1, update2 } = createBigUpdates()
  const disabledPool = createComputePool({ poolSize: 1 })
  const { updates, telemetry } = createCollector()
  const enabledPool = createComputePool({ poolSize: 1, record: telemetry.record })
  const [disabledRes, enabledRes] = [await disabledPool.mergeUpdates(true, [update1, update2]), await enabledPool.mergeUpdates(true, [update1, update2])]
  t.compare(disabledRes, enabledRes)
  const small = Y.encodeStateAsUpdate(new Y.Doc())
  t.compare(await disabledPool.mergeUpdates(true, [small, small]), await enabledPool.mergeUpdates(true, [small, small]))
  t.assert(disabledPool.record.updates.length === 0, 'discard record stays empty')
  await flushed()
  t.assert(tel.buildTree(updates).length === 2, 'collector saw one root per task')
  await disabledPool.destroy()
  await enabledPool.destroy()
}

/**
 * A pooled task streams a full span: sizes, queue-wait, result size, replayable input.
 *
 * @param {t.TestCase} _tc
 */
export const testComputeTaskUpdates = async _tc => {
  const { update1, update2 } = createBigUpdates()
  const { updates, telemetry } = createCollector()
  const pool = createComputePool({ poolSize: 1, record: telemetry.record })
  const merged = await pool.mergeUpdates(true, [update1, update2])
  await flushed()
  const root = /** @type {tel.SpanNode} */ (tel.buildTree(updates).find(n => n.name === 'yhub.compute.task'))
  t.assert(root != null && root.success && !root.err)
  t.assert(root.parent === null)
  t.assert(root.attributes.task === 'mergeUpdates')
  t.assert(root.attributes.inline === undefined, 'pooled task is not inline')
  t.assert(root.attributes.updates === 2)
  t.assert(root.attributes.updateSize > 5120)
  t.assert(root.attributes.resultSize > 0)
  t.assert(Number.isInteger(root.time) && Number.isInteger(root.duration) && root.duration > 0)
  t.assert(root.attributes.queueMs >= 0 && root.attributes.queueMs <= root.duration / 1e6 + 0.1)
  // the lazy input thunk hands back the live task — buffers are structured-clone copies,
  // never detached, so the task is replayable
  const input = /** @type {import('../src/compute.js').ComputeTask} */ (root.attributes.input())
  t.assert(input.type === 'mergeUpdates')
  if (input.type === 'mergeUpdates') {
    t.compare(input.updates[0], update1)
    const replayed = await pool.mergeUpdates(true, /** @type {Array<Uint8Array<ArrayBuffer>>} */ (input.updates))
    t.compare(replayed, merged)
  }
  // inline fast path tags inline: true and never waits for a worker
  const small = Y.encodeStateAsUpdate(new Y.Doc())
  await pool.mergeUpdates(true, [small, small])
  await flushed()
  const inlineRoot = /** @type {tel.SpanNode} */ (tel.buildTree(updates).find(n => n.name === 'yhub.compute.task' && n.attributes.inline === true))
  t.assert(inlineRoot != null && inlineRoot.attributes.queueMs === undefined)
  await pool.destroy()
}

/**
 * Worker-thread crashes and inline throws flag the span and reject/throw for the caller.
 *
 * @param {t.TestCase} _tc
 */
export const testErrorUpdates = async _tc => {
  const { updates, telemetry } = createCollector()
  const pool = createComputePool({ poolSize: 1, record: telemetry.record })
  const garbage = new Uint8Array(3000).fill(255)
  let err = /** @type {Error?} */ (null)
  try {
    await pool.mergeUpdates(true, [garbage, garbage.slice()])
  } catch (e) {
    err = /** @type {Error} */ (e)
  }
  t.assert(err != null, 'worker-thread failure rejects the task')
  err = null
  try {
    await pool.computeStateVector(new Uint8Array(100).fill(255))
  } catch (e) {
    err = /** @type {Error} */ (e)
  }
  t.assert(err != null, 'inline failure propagates')
  await flushed()
  const roots = tel.buildTree(updates)
  const workerRoot = /** @type {tel.SpanNode} */ (roots.find(n => n.attributes.task === 'mergeUpdates'))
  t.assert(workerRoot.err && !workerRoot.success && typeof workerRoot.attributes.error.message === 'string')
  const inlineRoot = /** @type {tel.SpanNode} */ (roots.find(n => n.attributes.task === 'computeStateVector'))
  t.assert(inlineRoot.err && inlineRoot.attributes.inline === true && typeof inlineRoot.attributes.error.stack === 'string')
  await pool.destroy()
}

/**
 * Terminating the pool ends the dispatched AND the queued span with an error.
 *
 * @param {t.TestCase} _tc
 */
export const testTerminate = async _tc => {
  const { update1, update2 } = createBigUpdates()
  const { updates, telemetry } = createCollector()
  const pool = createComputePool({ poolSize: 1, record: telemetry.record })
  const taskA = pool.mergeUpdates(true, [update1, update2])
  const taskB = pool.mergeUpdates(true, [update1, update2])
  const destroyed = pool.destroy()
  for (const task of [taskA, taskB]) {
    let err = /** @type {Error?} */ (null)
    try {
      await task
    } catch (e) {
      err = /** @type {Error} */ (e)
    }
    t.assert(err != null && err.message === 'Worker terminated')
  }
  await flushed()
  const roots = tel.buildTree(updates)
  t.assert(roots.length === 2 && roots.every(n => n.err && n.attributes.error.message === 'Worker terminated'))
  await destroyed
}

/**
 * A throwing onUpdate consumer never breaks the pipeline.
 *
 * @param {t.TestCase} _tc
 */
export const testThrowingOnUpdate = async _tc => {
  const { update1, update2 } = createBigUpdates()
  const telemetry = /** @type {NonNullable<ReturnType<typeof createTelemetry>>} */ (createTelemetry({
    log: false,
    onUpdate: () => {
      throw new Error('consumer bug')
    }
  }))
  const pool = createComputePool({ poolSize: 1, record: telemetry.record })
  const merged = await pool.mergeUpdates(true, [update1, update2])
  t.assert(merged.byteLength > 0, 'task resolves despite throwing consumer')
  await flushed()
  await pool.destroy()
}

/**
 * OTel bridge: eagerly created spans with record timestamps — correct parenting
 * (getDoc → compute.task → worker phases), ERROR status, low-cardinality histogram.
 *
 * @param {t.TestCase} _tc
 */
export const testOtelSpanTree = async _tc => {
  const { updates, spanExporter, metricReader, telemetry } = createCollector()
  const pool = createComputePool({ poolSize: 1, record: telemetry.record })
  const { nongcDoc, contentmapBin } = createRollbackFixture()
  const room = { org: 'o', docid: 'd', branch: 'main' }
  const parent = telemetry.record.span('yhub.getDoc')
  parent.attr('room', room)
  const result = await pool.rollback({ nongcDoc, contentmapBin, by: 'user2', userid: 'admin', customAttributions: [] }, { room, span: parent })
  parent.end()
  t.assert(result.update != null)
  await flushed()
  const spans = spanExporter.getFinishedSpans()
  const taskSpan = /** @type {import('@opentelemetry/sdk-trace-base').ReadableSpan} */ (spans.find(s => s.name === 'yhub.compute.task'))
  const parentSpan = /** @type {import('@opentelemetry/sdk-trace-base').ReadableSpan} */ (spans.find(s => s.name === 'yhub.getDoc'))
  t.assert(taskSpan != null && parentSpan != null)
  t.assert(taskSpan.parentSpanContext?.spanId === parentSpan.spanContext().spanId)
  t.assert(taskSpan.spanContext().traceId === parentSpan.spanContext().traceId)
  const phaseSpans = spans.filter(s => ['decodeContentmap', 'filterAttributions', 'applyUpdate', 'undoContentIds', 'createContentmap'].includes(s.name))
  t.assert(phaseSpans.length >= 3, 'worker phases become child spans')
  phaseSpans.forEach(p => t.assert(p.parentSpanContext?.spanId === taskSpan.spanContext().spanId))
  t.assert(taskSpan.attributes['yhub.task'] === 'rollback')
  t.assert(taskSpan.attributes['yhub.room'] === 'o/d/main')
  // durations: OTel span duration equals the record's offset-ns measurement
  const getDocNode = /** @type {tel.SpanNode} */ (tel.buildTree(updates).find(n => n.name === 'yhub.getDoc'))
  const taskNode = /** @type {tel.SpanNode} */ (getDocNode.children.find(n => n.name === 'yhub.compute.task'))
  const hrMs = (/** @type {[number, number]} */ hr) => hr[0] * 1000 + hr[1] / 1e6
  t.assert(Math.abs((hrMs(taskSpan.endTime) - hrMs(taskSpan.startTime)) - taskNode.duration / 1e6) < 0.01)
  t.assert(Math.abs(hrMs(taskSpan.startTime) - (telemetry.record.origin + taskNode.time) / 1e6) < 5)
  // rebased worker phases sit inside the task window (±2ms cross-thread alignment)
  t.assert(taskNode.children.length === phaseSpans.length)
  taskNode.children.forEach(p => {
    t.assert(p.time >= taskNode.time - 2e6 && p.time + p.duration <= taskNode.time + taskNode.duration + 2e6)
  })
  // errors: recordException + ERROR status
  const garbage = new Uint8Array(3000).fill(255)
  try {
    await pool.mergeUpdates(true, [garbage, garbage.slice()])
  } catch (_e) {}
  await flushed()
  const errSpan = /** @type {import('@opentelemetry/sdk-trace-base').ReadableSpan} */ (spanExporter.getFinishedSpans().find(s => s.name === 'yhub.compute.task' && s.status.code === SpanStatusCode.ERROR))
  t.assert(errSpan != null)
  t.assert(errSpan.events.some(e => e.name === 'exception'))
  // metrics: op-level spans only, low-cardinality attrs only
  const { resourceMetrics } = await metricReader.collect()
  const metric = /** @type {import('@opentelemetry/sdk-metrics').MetricData} */ (resourceMetrics.scopeMetrics.flatMap(sm => sm.metrics).find(m => m.descriptor.name === 'yhub.op.duration'))
  t.assert(metric != null && metric.dataPoints.length > 0)
  t.assert(metric.dataPoints.some(dp => dp.attributes['yhub.op'] === 'yhub.compute.task'))
  t.assert(!metric.dataPoints.some(dp => dp.attributes['yhub.op'] === 'decodeContentmap'), 'worker phases stay out of the histogram')
  t.assert(!metric.dataPoints.some(dp => dp.attributes['yhub.room'] !== undefined), 'no high-cardinality metric labels')
  await pool.destroy()
}

/**
 * The worker compact cycle streams a span tree: worker.compact → getDoc → compute.task.
 *
 * @param {t.TestCase} _tc
 */
export const testCompactCycle = async _tc => {
  /**
   * @type {Array<import('../src/telemetry.js').SpanUpdate>}
   */
  const updates = []
  const hub = await utils.createTestHub({
    redis: object.assign({}, utils.yhub.conf.redis, { prefix: 'yhub:testing:telemetry' }),
    worker: { taskConcurrency: 100 },
    telemetry: { onUpdate: us => updates.push(...us), log: 'debug' }
  })
  const room = { org: 'testOrg', docid: 'telemetry-compact', branch: 'main' }
  const doc = new Y.Doc()
  doc.get('test').insert(0, 'telemetry compact test')
  const update = Y.encodeStateAsUpdate(doc)
  const contentmap = Y.encodeContentMap(Y.createContentMapFromContentIds(
    Y.createContentIdsFromUpdate(update),
    [Y.createContentAttribute('insert', 'user1'), Y.createContentAttribute('insertAt', 1000)],
    [Y.createContentAttribute('delete', 'user1'), Y.createContentAttribute('deleteAt', 1000)]
  ))
  await hub.stream.addMessage(room, { type: 'ydoc:update:v1', update, contentmap })
  await utils.waitTasksProcessed(hub)
  hub.stopWorker()
  await flushed()
  const compact = /** @type {tel.SpanNode} */ (tel.buildTree(updates).find(n => n.name === 'yhub.worker.compact' && n.attributes.room?.docid === room.docid && n.attributes.trimOnly === undefined))
  t.assert(compact != null && compact.success && !compact.err)
  t.assert(compact.attributes.gcDocSize > 0)
  t.assert(compact.attributes.storeMs != null && compact.attributes.trimMs != null)
  const getDocNode = /** @type {tel.SpanNode} */ (compact.children.find(n => n.name === 'yhub.getDoc'))
  t.assert(getDocNode != null, 'getDoc nests under the compact span')
  t.assert(getDocNode.attributes.cachedMessages >= 1)
  const computeNodes = getDocNode.children.filter(n => n.name === 'yhub.compute.task')
  t.assert(computeNodes.length >= 1, 'compute tasks nest under getDoc')
  doc.destroy()
  await hub.computePool.destroy()
}
