import config from './config.js'
import { median } from './report.js'

/**
 * Timing and heap-measurement helpers for the pure-CPU benchmarks.
 */

/**
 * Median wall-clock duration of `fn` over `config.run.runs` timed iterations,
 * after `config.run.warmupRuns` discarded ones. Median rather than mean so a
 * single GC pause does not become the reported number.
 *
 * @param {() => any} fn
 * @param {{ runs?: number, warmup?: number }} [opts]
 */
export const timeIt = (fn, { runs = config.run.runs, warmup = config.run.warmupRuns } = {}) => {
  for (let i = 0; i < warmup; i++) fn()
  /** @type {Array<number>} */
  const samples = []
  for (let i = 0; i < runs; i++) {
    const started = performance.now()
    fn()
    samples.push(performance.now() - started)
  }
  return median(samples)
}

/**
 * @param {() => Promise<any>} fn
 * @param {{ runs?: number, warmup?: number }} [opts]
 */
export const timeItAsync = async (fn, { runs = config.run.runs, warmup = config.run.warmupRuns } = {}) => {
  for (let i = 0; i < warmup; i++) await fn()
  /** @type {Array<number>} */
  const samples = []
  for (let i = 0; i < runs; i++) {
    const started = performance.now()
    await fn()
    samples.push(performance.now() - started)
  }
  return median(samples)
}

const gc = () => {
  const g = /** @type {any} */ (globalThis).gc
  if (g) { g(); g() }
}

/**
 * Memory retained by whatever `fn` returns, in MB. Requires `--expose-gc`, which
 * the `npm start` script passes; without it the number is noise and is reported
 * as `NaN` rather than silently wrong.
 *
 * Reports the JS heap and `external`/`arrayBuffers` separately, and it matters
 * which: a document whose content is strings retains it on the JS heap, while
 * one whose content is `Uint8Array` blobs retains it outside — `heapUsed` alone
 * would report ~0 MB for a 50 MB document and look like a free lunch. `totalMB`
 * is what actually has to fit in the process.
 *
 * @template T
 * @param {() => T} fn
 * @return {{ result: T, heapMB: number, externalMB: number, totalMB: number }}
 */
export const measureRetainedHeap = fn => {
  if (/** @type {any} */ (globalThis).gc == null) return { result: fn(), heapMB: NaN, externalMB: NaN, totalMB: NaN }
  const MB = 1024 * 1024
  gc()
  const before = process.memoryUsage()
  const result = fn()
  gc()
  const after = process.memoryUsage()
  const heapMB = (after.heapUsed - before.heapUsed) / MB
  const externalMB = (after.external - before.external) / MB
  return { result, heapMB, externalMB, totalMB: heapMB + externalMB }
}
