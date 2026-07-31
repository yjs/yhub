import * as fs from 'node:fs'
import { Transform } from 'node:stream'
import { monitorEventLoopDelay } from 'node:perf_hooks'

/**
 * Metric collection.
 *
 * Child-side (`createChildMetrics`) runs inside the forked server/worker
 * processes and reports deltas between a `mark` and a `collect`. Parent-side
 * helpers query Redis and Postgres directly.
 *
 * y/hub has no telemetry hooks, so everything here is either a public field
 * (`computePool.queue`), a documented callback (`worker.events.*`), or a wrapper
 * around an object the benchmark itself constructed (the S3 client). Nothing is
 * monkey-patched into library internals.
 */

const MB = 1024 * 1024

/**
 * Peak RSS since the process started, or since the last `resetPeakRss()`.
 * Linux-only; returns `null` elsewhere, and callers fall back to sampled RSS.
 */
export const readVmHWM = () => {
  try {
    const m = fs.readFileSync('/proc/self/status', 'utf8').match(/VmHWM:\s+(\d+) kB/)
    return m ? Number(m[1]) * 1024 : null
  } catch (_) { return null }
}

/**
 * Reset the kernel's peak-RSS watermark so the next `readVmHWM()` reports the
 * peak of this benchmark rather than of the whole process lifetime.
 */
export const resetPeakRss = () => {
  try { fs.writeFileSync('/proc/self/clear_refs', '5'); return true } catch (_) { return false }
}

/**
 * Counters for S3 operations. `s3Ops` matters more than local MinIO latency:
 * counts let real-world S3/R2 latency be layered on analytically.
 */
export const createS3Counters = () => ({ gets: 0, puts: 0, deletes: 0, getBytes: 0, putBytes: 0 })

/**
 * Wrap the minio client of an `S3PersistenceV1` instance so every operation is
 * counted, including the one retry each call site performs.
 *
 * @param {any} plugin
 * @param {ReturnType<createS3Counters>} counters
 */
export const countS3Ops = (plugin, counters) => {
  const client = plugin.s3client
  const put = client.putObject.bind(client)
  const get = client.getObject.bind(client)
  const del = client.removeObject.bind(client)
  /** @param {any[]} args */
  client.putObject = (...args) => {
    counters.puts++
    // putObject(bucket, path, stream, size) — the caller passes a Readable, so
    // the size argument is the only reliable byte count
    counters.putBytes += typeof args[3] === 'number' ? args[3] : 0
    return put(...args)
  }
  /** @param {any[]} args */
  client.getObject = async (...args) => {
    counters.gets++
    const stream = await get(...args)
    // count through a Transform rather than a 'data' listener: a listener would
    // put the stream into flowing mode and race the caller's `for await`
    const counting = new Transform({
      transform (chunk, _enc, cb) { counters.getBytes += chunk.length; cb(null, chunk) }
    })
    return stream.pipe(counting)
  }
  /** @param {any[]} args */
  client.removeObject = (...args) => {
    counters.deletes++
    return del(...args)
  }
  return plugin
}

/**
 * Per-process sampler. Call `mark()` at the start of a benchmark and `collect()`
 * at the end; everything reported is the delta between the two.
 *
 * @param {object} opts
 * @param {number} opts.intervalMs
 * @param {() => number} [opts.queueDepth] compute-pool queue length
 * @param {ReturnType<createS3Counters>} [opts.s3]
 */
export const createChildMetrics = ({ intervalMs, queueDepth = () => 0, s3 }) => {
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  let cpuBase = process.cpuUsage()
  let queueDepthMax = 0
  let rssMax = 0
  let s3Base = s3 ? { ...s3 } : null
  const timer = setInterval(() => {
    queueDepthMax = Math.max(queueDepthMax, queueDepth())
    rssMax = Math.max(rssMax, process.memoryUsage.rss())
  }, intervalMs)
  timer.unref()
  return {
    mark () {
      loop.reset()
      cpuBase = process.cpuUsage()
      queueDepthMax = 0
      rssMax = process.memoryUsage.rss()
      s3Base = s3 ? { ...s3 } : null
      resetPeakRss()
    },
    collect () {
      const cpu = process.cpuUsage(cpuBase)
      const mem = process.memoryUsage()
      const peak = readVmHWM()
      return {
        rssPeakMB: (peak != null ? Math.max(peak, rssMax) : rssMax) / MB,
        rssEndMB: mem.rss / MB,
        heapUsedMB: mem.heapUsed / MB,
        externalMB: mem.external / MB,
        arrayBuffersMB: mem.arrayBuffers / MB,
        cpuMs: (cpu.user + cpu.system) / 1000,
        cpuUserMs: cpu.user / 1000,
        loopDelayP99Ms: loop.percentile(99) / 1e6,
        loopDelayMaxMs: loop.max / 1e6,
        queueDepthMax,
        s3: s3 && s3Base
          ? {
              gets: s3.gets - s3Base.gets,
              puts: s3.puts - s3Base.puts,
              deletes: s3.deletes - s3Base.deletes,
              getBytes: s3.getBytes - s3Base.getBytes,
              putBytes: s3.putBytes - s3Base.putBytes
            }
          : null
      }
    },
    stop () { clearInterval(timer); loop.disable() }
  }
}

/**
 * @typedef {ReturnType<ReturnType<createChildMetrics>['collect']>} ProcessMetrics
 */

/**
 * Sum the metrics of several processes into one row-friendly object. Peaks are
 * maxed, everything else summed, so a 3-pod run reports "the worst pod's peak"
 * and "the fleet's total cpu".
 *
 * @param {Array<ProcessMetrics>} all
 */
export const sumProcessMetrics = all => {
  const zero = { rssPeakMB: 0, rssEndMB: 0, heapUsedMB: 0, externalMB: 0, arrayBuffersMB: 0, cpuMs: 0, cpuUserMs: 0, loopDelayP99Ms: 0, loopDelayMaxMs: 0, queueDepthMax: 0 }
  const s3 = createS3Counters()
  const out = all.reduce((acc, m) => {
    acc.rssPeakMB = Math.max(acc.rssPeakMB, m.rssPeakMB)
    acc.rssEndMB += m.rssEndMB
    acc.heapUsedMB += m.heapUsedMB
    acc.externalMB += m.externalMB
    acc.arrayBuffersMB += m.arrayBuffersMB
    acc.cpuMs += m.cpuMs
    acc.cpuUserMs += m.cpuUserMs
    acc.loopDelayP99Ms = Math.max(acc.loopDelayP99Ms, m.loopDelayP99Ms)
    acc.loopDelayMaxMs = Math.max(acc.loopDelayMaxMs, m.loopDelayMaxMs)
    acc.queueDepthMax = Math.max(acc.queueDepthMax, m.queueDepthMax)
    if (m.s3) {
      s3.gets += m.s3.gets; s3.puts += m.s3.puts; s3.deletes += m.s3.deletes
      s3.getBytes += m.s3.getBytes; s3.putBytes += m.s3.putBytes
    }
    return acc
  }, { ...zero })
  return { ...out, s3 }
}
