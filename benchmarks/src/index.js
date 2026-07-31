import config from './config.js'
import { Reporter, freeDiskGiB } from './report.js'
import { stopCluster, reclaimStorage, takeTaskFailures } from './cluster.js'
import { derivedSection } from './derive.js'

/**
 * Benchmark runner.
 *
 *   npm start              every group in config.run.suites
 *   npm start -- y1        one group
 *   npm start -- y2.4 y5   any mix of group and benchmark ids
 *
 * Rows print as they are produced, so a long run stays watchable, and are
 * written to RESULTS.md at the end.
 */

const suiteFiles = {
  y0: './suites/y0-fixtures.js',
  y1: './suites/y1-primitives.js',
  y2: './suites/y2-connections.js',
  y3: './suites/y3-writes.js',
  y4: './suites/y4-observers.js',
  y5: './suites/y5-lifetime.js',
  y6: './suites/y6-scenarios.js',
  y7: './suites/y7-trace.js'
}

const filters = process.argv.slice(2).map(s => s.toLowerCase())

/** @param {string} suiteId */
const suiteSelected = suiteId => filters.length === 0
  ? config.run.suites.includes(suiteId)
  : filters.some(f => f === suiteId || f.startsWith(suiteId + '.'))

/** @param {string} benchId */
const benchSelected = benchId => filters.length === 0 || filters.some(f => f.length <= 2 || benchId.toLowerCase().startsWith(f))

/**
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 * @param {string} label
 */
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref())
])

/**
 * A run of this suite writes several GB to S3 — every compaction rewrites the
 * whole document and its nongc twin. If the storage backend fills up, MinIO
 * starts refusing writes, compaction fails rather than slows, rooms never drain,
 * and benchmarks time out with numbers that look plausible and are not. Cheaper
 * to say so up front than to debug it afterwards.
 */
const preflight = () => {
  const free = freeDiskGiB()
  const biggest = Math.max(...config.scale.docSizes, config.scale.scenario.docSize) / 1024 ** 2
  const wanted = Math.max(10, Math.ceil(biggest / 1024 * 40))
  if (free != null && free < wanted) {
    console.warn(`\x1b[33m⚠ ${free.toFixed(1)} GiB free, and documents of up to ${biggest.toFixed(0)} MB want roughly ${wanted} GiB of headroom.`)
    console.warn('  A full S3 backend makes compaction fail rather than slow down, which silently invalidates Y5 and Y6.\x1b[0m')
  }
}

const run = async () => {
  preflight()
  const report = new Reporter(config)
  const ctx = { config, report }
  // y0 always runs: it lists the fixtures every other group is measured against,
  // and generating them up front keeps generation cost out of the timings.
  for (const suiteId of Object.keys(suiteFiles)) {
    if (suiteId !== 'y0' && !suiteSelected(suiteId)) continue
    const suite = (await import(suiteFiles[/** @type {keyof typeof suiteFiles} */ (suiteId)])).default
    for (const bench of suite.benchmarks.filter(/** @param {any} b */ b => benchSelected(b.id))) {
      const benchReport = report.begin({ suite: suiteId, suiteTitle: suite.title, id: bench.id, name: bench.name })
      try {
        await withTimeout(bench.run({ ...ctx, report: benchReport }), config.run.benchmarkTimeoutMs, bench.id)
      } catch (err) {
        benchReport.note(`**failed:** ${/** @type {Error} */ (err).message}`)
      } finally {
        const failures = takeTaskFailures()
        if (failures > 0) {
          benchReport.warn(`${failures} compaction task(s) failed during this benchmark, so these numbers are not a valid measurement. The usual cause is a full S3 backend: compaction then fails rather than slows, the room is never persisted, and everything downstream of it is wrong. Check free disk and re-run.`)
        }
        benchReport.close()
        await reclaimStorage()
      }
    }
  }
  await stopCluster()
  const outPath = new URL('../' + config.run.outFile, import.meta.url).pathname
  report.write(outPath, derivedSection(report))
}

process.on('SIGINT', () => { stopCluster().finally(() => process.exit(130)) })

run().then(
  () => process.exit(0),
  err => { console.error(err); stopCluster().finally(() => process.exit(1)) }
)
