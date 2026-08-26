import * as promise from 'lib0/promise'
import config from '../config.js'
import { getCluster } from '../cluster.js'
import { getFixture, makeBatchUpdate, sizeLabel } from '../fixtures.js'
import { RawClient, updateFrame } from '../client.js'
import { stats } from '../report.js'

/**
 * Y5: what does a document's lifetime cost?
 *
 * The background cost nobody sees, and the group most relevant to
 * agent-generated content. Compaction is triggered when a document receives its
 * first write after being idle and re-triggered immediately after each
 * compaction while the stream is non-empty (`src/stream.js:192-197`), so a
 * continuously edited document is compacted roughly every `taskDebounce` seconds and
 * **every compaction rewrites the whole document**.
 */

const MB = 1024 * 1024

/**
 * Grow a document from empty by streaming `chunk`-sized updates until the
 * persisted document reaches `targetBytes`, sampling the backlog as it goes.
 *
 * @param {import('../cluster.js').Cluster} cluster
 * @param {string} docid
 * @param {number} targetBytes
 * @param {number} chunkBytes
 */
const growDocument = async (cluster, docid, targetBytes, chunkBytes) => {
  const cellsPerChunk = Math.max(1, Math.round(chunkBytes / 42))
  const writer = await new RawClient({ port: cluster.ports[0], docid }).connect()
  let written = 0
  let seq = 0
  /** @type {Array<{ streamLen: number, pgRows: number }>} */
  const backlog = []
  const started = performance.now()
  while (written < targetBytes) {
    const update = makeBatchUpdate(cellsPerChunk, 800000 + seq++)
    writer.send(updateFrame(update))
    written += update.byteLength
    await promise.wait(20)
    if (seq % 10 === 0) {
      backlog.push({ streamLen: await cluster.streamLen({ docid }), pgRows: await cluster.pgRows({ docid }) })
    }
  }
  const writeMs = performance.now() - started
  await cluster.drain()
  writer.close()
  return { written, writeMs, backlog, chunks: seq }
}

export default {
  id: 'y5',
  title: "Y5: What does a document's lifetime cost?",
  benchmarks: [
    {
      id: 'Y5.1',
      name: 'Grow a document from empty to size S by streaming updates',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        const target = config.scale.growthTarget
        await cluster.mark()
        const { written, writeMs, backlog, chunks } = await growDocument(cluster, 'y51', target, config.scale.growthChunk)
        const m = await cluster.collect()
        const s3PutMB = m.worker.s3.putBytes / MB
        report.row({
          'target (MB)': target / MB,
          'written by clients (MB)': written / MB,
          chunks,
          'time (s)': writeMs / 1000,
          compactions: m.tasks.length,
          'workerTime total (ms)': m.tasks.reduce((a, t) => a + t.durationMs, 0),
          'workerTime p95 (ms)': stats(m.tasks.map(t => t.durationMs)).p95,
          'workerMem peak (MB)': m.worker.rssPeakMB,
          's3 puts': m.worker.s3.puts,
          's3 written (MB)': s3PutMB,
          's3 gets': m.worker.s3.gets,
          'write amplification': s3PutMB / (written / MB),
          'streamLen max': Math.max(0, ...backlog.map(b => b.streamLen)),
          'pgRows max': Math.max(0, ...backlog.map(b => b.pgRows))
        })
        report.note('The headline result is `write amplification`: bytes pushed to S3 per byte of document the clients actually wrote. Every compaction rewrites the whole document *and* its nongc twin, so building a document incrementally costs far more than its final size — this is the number that decides whether an agent workload is affordable.')
      }
    },
    {
      id: 'Y5.2',
      name: 'Y5.1 sweeping taskDebounce',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const target = config.scale.growthTarget
        for (const taskDebounce of config.scale.taskDebounces) {
          const cluster = await getCluster({ taskDebounce })
          await cluster.mark()
          const { written, writeMs, backlog } = await growDocument(cluster, `y52-${taskDebounce}`, target, config.scale.growthChunk)
          const m = await cluster.collect()
          // sync cost at the end of the growth, when the backlog is deepest
          await cluster.flushCache()
          const reader = await new RawClient({ port: cluster.ports[0], docid: `y52-${taskDebounce}` }).connect()
          report.row({
            'taskDebounce (ms)': taskDebounce,
            'written (MB)': written / MB,
            'time (s)': writeMs / 1000,
            compactions: m.tasks.length,
            'workerTime total (ms)': m.tasks.reduce((a, t) => a + t.durationMs, 0),
            's3 written (MB)': m.worker.s3.putBytes / MB,
            'write amplification': (m.worker.s3.putBytes / MB) / (written / MB),
            'streamLen max': Math.max(0, ...backlog.map(b => b.streamLen)),
            'pgRows max': Math.max(0, ...backlog.map(b => b.pgRows)),
            'syncTime after growth (ms)': reader.syncTimeMs
          })
          reader.close()
        }
        report.note('The central trade-off. Compacting less often means less rewriting, but longer Redis streams, more uncompacted Postgres rows, more S3 GETs per sync, and a slower sync. Read `write amplification` against `syncTime after growth` to pick a setting for your growth rate.\n\n**This parameter used to have a floor that was not about the trade-off at all**: `taskDebounce` is the `XAUTOCLAIM` min-idle-time, and a worker re-claimed with its own consumer name, so any value below the actual compaction time made it run the same task twice (see Y6.2). The worker now renews the lease of a running task, so values under the compaction times in Y5.1 measure the trade-off rather than a broken configuration.')
      }
    },
    {
      id: 'Y5.3',
      name: 'Compact a document of size S: fresh vs. churned vs. row-churn',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        const targetBytes = config.fixtures.churnTarget
        for (const variant of /** @type {Array<'fresh'|'churned'|'rowChurn'>} */ (['fresh', 'churned', 'rowChurn'])) {
          const fixture = getFixture({ variant, targetBytes })
          const docid = `y53-${variant}`
          const writer = await new RawClient({ port: cluster.ports[0], docid }).connect()
          await cluster.mark()
          writer.send(updateFrame(fixture.update))
          await cluster.awaitWrite({ docid })
          await cluster.drain(300000)
          const m = await cluster.collect()
          const compaction = m.compactions[m.compactions.length - 1]
          report.row({
            variant,
            S: sizeLabel(targetBytes),
            cells: fixture.cells,
            'input (MB)': fixture.update.byteLength / MB,
            'gcDoc (MB)': (compaction?.gcBytes ?? 0) / MB,
            'nongcDoc (MB)': (compaction?.nongcBytes ?? 0) / MB,
            'workerTime (ms)': stats(m.tasks.map(t => t.durationMs)).max,
            'workerMem peak (MB)': m.worker.rssPeakMB,
            's3 puts': m.worker.s3.puts,
            's3 written (MB)': m.worker.s3.putBytes / MB
          })
          writer.close()
        }
        report.note('The worker persists **both** the gc and the nongc document (`src/index.js:85`). Overwriting a cell tombstones the old value, so a spreadsheet worked on for a week can be modest in gc and enormous in nongc — `nongcDoc` against `gcDoc` is how much the history actually costs, and it is paid on every single compaction, not once.')
      }
    },
    {
      id: 'Y5.4',
      name: 'taskConcurrency sweep',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const targetBytes = config.scale.scenario.docSize
        const { gcUpdate } = getFixture({ targetBytes })
        for (const taskConcurrency of config.scale.taskConcurrencies) {
          const cluster = await getCluster({ taskConcurrency })
          const docs = taskConcurrency * 2
          await cluster.mark()
          const started = performance.now()
          /** @type {Array<RawClient>} */
          const writers = []
          for (let i = 0; i < docs; i++) {
            const w = await new RawClient({ port: cluster.ports[0], docid: `y54-${taskConcurrency}-${i}` }).connect()
            w.send(updateFrame(gcUpdate))
            writers.push(w)
          }
          await cluster.awaitWrite({ docid: `y54-${taskConcurrency}-0` })
          const drained = await cluster.drain(300000)
          const elapsed = performance.now() - started
          const m = await cluster.collect()
          report.row({
            taskConcurrency,
            documents: docs,
            'S each': sizeLabel(targetBytes),
            'time (s)': elapsed / 1000,
            'tasks/s': m.tasks.length / (elapsed / 1000),
            compactions: m.tasks.length,
            'workerTime p95 (ms)': stats(m.tasks.map(t => t.durationMs)).p95,
            'workerMem peak (MB)': m.worker.rssPeakMB,
            'peak MB per concurrent task': m.worker.rssPeakMB / taskConcurrency,
            errors: m.tasks.filter(t => t.error).length,
            drained: drained ? 'yes' : 'no'
          })
          writers.forEach(w => w.close())
        }
        report.note('`bin/yhub.js` ships `taskConcurrency: 5`; `tests/utils.js` uses 500. At 40 MB one of those is wrong, and this is where the OOM boundary is. Peak worker memory is roughly `expansion factor × (gc + nongc) × taskConcurrency` — cross-check against the `Y.Doc` expansion factor from Y1.4.')
      }
    },
    {
      id: 'Y5.5',
      name: 'Steady state: a document under continuous edits',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        const docid = 'y55'
        const { gcUpdate } = getFixture({ targetBytes: config.scale.docSizes[config.scale.docSizes.length - 1] })
        const writer = await new RawClient({ port: cluster.ports[0], docid }).connect()
        writer.send(updateFrame(gcUpdate))
        await cluster.awaitWrite({ docid })
        await cluster.drain(300000)
        await cluster.mark()
        const started = performance.now()
        /** @type {Array<{ t: number, streamLen: number, pgRows: number }>} */
        const samples = []
        let seq = 0
        while (performance.now() - started < config.scale.holdMs) {
          writer.send(updateFrame(makeBatchUpdate(20, 900000 + seq++)))
          await promise.wait(100)
          if (seq % 10 === 0) {
            samples.push({
              t: (performance.now() - started) / 1000,
              streamLen: await cluster.streamLen({ docid }),
              pgRows: await cluster.pgRows({ docid })
            })
          }
        }
        const m = await cluster.collect()
        samples.forEach(s => report.row({
          't (s)': s.t,
          streamLen: s.streamLen,
          pgRows: s.pgRows
        }))
        report.row({
          't (s)': 'TOTAL',
          streamLen: '',
          pgRows: '',
          'edits sent': seq,
          compactions: m.tasks.length,
          'workerTime p95 (ms)': stats(m.tasks.map(t => t.durationMs)).p95,
          'workerCpu (ms)': m.worker.cpuMs,
          's3 written (MB)': m.worker.s3.putBytes / MB
        })
        writer.close()
        await cluster.drain()
        report.note('Is compaction keeping up? A flat `streamLen` and `pgRows` mean yes. Rising ones mean no — and because every uncompacted row is an extra S3 GET on every sync, every sync is getting more expensive while it happens. This is the metric to alert on in production.')
      }
    }
  ]
}
