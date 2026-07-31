import * as Y from '@y/y'
import * as promise from 'lib0/promise'
import { mergeUpdates } from '../../../src/y-utils.js'
import config from '../config.js'
import { getCluster } from '../cluster.js'
import { splitTrace } from '../trace.js'
import { makeCellUpdates } from '../fixtures.js'
import { RawClient, updateFrame, connectClients, closeClients } from '../client.js'
import { timeIt, measureRetainedHeap } from '../measure.js'
import { stats } from '../report.js'

/**
 * Y7: a real editing trace.
 *
 * Y1–Y6 measure synthetic documents, which is what makes them reproducible on
 * any machine — but the shapes are ours. This group replays a customer's actual
 * document and actual edits, so the constants can be checked against a workload
 * nobody designed to be convenient.
 *
 * Skipped entirely when `benchmarks/custom-trace.anyenc` is absent. The trace is
 * customer data and is gitignored; `TRACE-FORMAT.md` documents its format.
 */

const MB = 1024 * 1024

/**
 * @param {import('../report.js').Reporter} report
 */
const skip = report => {
  report.note(`**Not run** — no editing trace supplied. Y7 replays a real customer document and its real edits, which measures shapes the synthetic fixtures cannot: opaque bulk blobs, very few CRDT structs for the byte count, and an edit distribution nobody tuned. Drop one at \`benchmarks/${config.trace.file}\` (format in [TRACE-FORMAT.md](../TRACE-FORMAT.md)) and this group runs automatically. The file is gitignored on purpose.`)
}

/**
 * Put the traced document into a room, compacted, exactly as a real deployment
 * would hold it.
 *
 * @param {import('../cluster.js').Cluster} cluster
 * @param {string} docid
 * @param {Uint8Array<ArrayBuffer>} baseline
 */
const seedTraced = async (cluster, docid, baseline) => {
  const w = await new RawClient({ port: cluster.ports[0], docid }).connect()
  w.send(updateFrame(baseline))
  await cluster.awaitWrite({ docid })
  w.close()
  await cluster.drain(600000)
}

export default {
  id: 'y7',
  title: 'Y7: A real editing trace',
  benchmarks: [
    {
      id: 'Y7.1',
      name: 'Primitive costs on the traced document',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const split = splitTrace()
        if (split == null) return skip(report)
        const { trace, baseline, edits } = split
        const doc = new Y.Doc({ gc: true })
        trace.updates.forEach(u => Y.applyUpdate(doc, u.update))
        const gcUpdate = Y.encodeStateAsUpdate(doc)
        doc.destroy()

        report.row({
          measurement: 'trace shape',
          value: `${trace.updates.length} updates, ${trace.users.length} users`,
          detail: `baseline ${(baseline.update.byteLength / MB).toFixed(1)} MB + ${edits.length} edits totalling ${edits.reduce((a, e) => a + e.update.byteLength, 0)} bytes`
        })

        const svTime = timeIt(() => Y.encodeStateVectorFromUpdate(gcUpdate))
        report.row({
          measurement: 'state vector (Y1.2)',
          value: `${svTime.toFixed(0)} ms`,
          detail: `${((gcUpdate.byteLength / MB) / (svTime / 1000)).toFixed(1)} MB/s over ${(gcUpdate.byteLength / MB).toFixed(1)} MB`
        })

        const pending = makeCellUpdates(1)
        const mergeTime = timeIt(() => mergeUpdates(false, [gcUpdate, ...pending]))
        report.row({
          measurement: 'binary merge, 1 pending (Y1.1)',
          value: `${mergeTime.toFixed(0)} ms`,
          detail: `${((gcUpdate.byteLength / MB) / (mergeTime / 1000)).toFixed(1)} MB/s — paid on every sync of an edited document`
        })

        const docMergeTime = timeIt(() => mergeUpdates(true, [gcUpdate, ...pending]))
        report.row({
          measurement: 'document merge (Y1.4)',
          value: `${docMergeTime.toFixed(0)} ms`,
          detail: `${((gcUpdate.byteLength / MB) / (docMergeTime / 1000)).toFixed(1)} MB/s — the core of compaction`
        })

        // Measure a doc built from its *own* copy of the update, so buffers the
        // document shares with an update we already held are counted rather
        // than showing up as free.
        const { result, totalMB } = measureRetainedHeap(() => {
          const own = new Uint8Array(gcUpdate)
          const d = new Y.Doc()
          Y.applyUpdate(d, own)
          return d
        })
        result.destroy()
        const docMB = gcUpdate.byteLength / MB
        report.row({
          measurement: 'Y.Doc retained memory (Y1.4)',
          value: `${totalMB.toFixed(0)} MB`,
          detail: `${(totalMB / docMB).toFixed(1)}× serialized (${docMB.toFixed(1)} MB) — binary content is retained as views over the update rather than re-materialised, unlike the string content in Y1.4`
        })

        const cidTime = timeIt(() => Y.createContentIdsFromUpdate(edits[0].update))
        report.row({
          measurement: 'content ids, one real edit (Y1.3)',
          value: `${cidTime.toFixed(3)} ms`,
          detail: `on the main thread for every inbound message; the edit is ${edits[0].update.byteLength} bytes`
        })

        report.note('The same primitives as Y1, on the customer document instead of a synthetic one — and the headline is how *unlike* the synthetic case it is. This document is ~51 MB but holds only a few hundred structs, because the bulk is opaque application blobs under `rncColumnBlocks` rather than fine-grained CRDT content. Every per-byte figure here is therefore an order of magnitude better than Y1 at a comparable size: **CRDT cost tracks struct count, not document size.** The practical consequence is that for this shape, syncing is dominated by moving the bytes rather than by merging them — so the remedy is caching and transfer, not a faster merge.')
      }
    },
    {
      id: 'Y7.2',
      name: 'Replay the real edit sequence',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const split = splitTrace()
        if (split == null) return skip(report)
        const { baseline, edits } = split
        const cluster = await getCluster()
        const docid = 'y72-trace'
        await seedTraced(cluster, docid, baseline.update)

        const writer = await new RawClient({ port: cluster.ports[0], docid }).connect()
        const observer = await new RawClient({ port: cluster.ports[0], docid }).connect()
        await cluster.mark()
        /** @type {Array<number>} */
        const propagation = []
        const started = performance.now()
        for (let r = 0; r < config.trace.replays; r++) {
          for (const edit of edits) {
            const before = observer.updatesReceived
            const sentAt = performance.now()
            writer.send(updateFrame(edit.update))
            const deadline = Date.now() + 15000
            while (observer.updatesReceived === before && Date.now() < deadline) await promise.wait(1)
            if (observer.updatesReceived > before) propagation.push(performance.now() - sentAt)
          }
        }
        const elapsed = performance.now() - started
        const m = await cluster.collect()
        const sent = edits.length * config.trace.replays
        const p = stats(propagation)
        report.row({
          edits: sent,
          'bytes sent': edits.reduce((a, e) => a + e.update.byteLength, 0) * config.trace.replays,
          'time (ms)': elapsed,
          'serverCpu (ms)': m.server.cpuMs,
          'µs cpu per edit': (m.server.cpuMs * 1000) / sent,
          'propagation p50 (ms)': p.p50,
          'propagation p95 (ms)': p.p95,
          'propagation p99 (ms)': p.p99,
          'propagation max (ms)': p.max,
          'not delivered': sent - propagation.length,
          'loopDelay p99 (ms)': m.server.loopDelayP99Ms,
          streamLen: await cluster.streamLen({ docid })
        })
        observer.close()
        writer.close()
        await cluster.drain(600000)
        report.note('The real edits, in order, against the real document — one at a time so each propagation figure is a clean edit-to-observer measurement rather than a queue. These edits are tiny (10–354 bytes) while the document is ~51 MB, which is the case the cost model cares about most: writing is cheap and independent of document size, but every one of these edits makes the *next* sync pay a full merge (see Y1.1 and Y7.3).')
      }
    },
    {
      id: 'Y7.3',
      name: 'N users syncing the traced document',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const split = splitTrace()
        if (split == null) return skip(report)
        const { baseline, edits } = split
        const cluster = await getCluster()
        for (const n of config.trace.users) {
          for (const pending of [0, 1]) {
            const docid = `y73-${n}-${pending}`
            await seedTraced(cluster, docid, baseline.update)
            if (pending > 0) {
              // one real edit since the last compaction — the state an actively
              // edited document is in essentially all of the time
              const w = await new RawClient({ port: cluster.ports[0], docid }).connect()
              w.send(updateFrame(edits[0].update))
              await promise.wait(300)
              w.close()
            }
            await cluster.flushCache()
            await cluster.mark()
            const ramped = n > config.trace.joinRateAbove
            const started = performance.now()
            const clients = await connectClients({
              count: n,
              target: () => ({ port: cluster.ports[0], docid }),
              ratePerSecond: ramped ? config.trace.joinRate : 0
            })
            const elapsed = performance.now() - started
            const m = await cluster.collect()
            const live = clients.filter(c => !c.dropped)
            const s = stats(live.map(c => c.syncTimeMs))
            report.row({
              N: n,
              'pending edits': pending,
              arrival: ramped ? `ramped ${config.trace.joinRate}/s` : 'all at once',
              'syncBytes (MB)': (clients[0]?.syncBytes ?? 0) / MB,
              'time (ms)': elapsed,
              'achieved (joins/s)': n / (elapsed / 1000),
              'syncTime p50 (ms)': s.p50,
              'syncTime p95 (ms)': s.p95,
              'syncTime p99 (ms)': s.p99,
              'syncTime max (ms)': s.max,
              'serverCpu (ms)': m.server.cpuMs,
              'cpu per sync (ms)': m.server.cpuMs / Math.max(1, live.length),
              'serverMem peak (MB)': m.server.rssPeakMB,
              'loopDelay p99 (ms)': m.server.loopDelayP99Ms,
              queueDepth: m.server.queueDepthMax,
              's3 gets': m.server.s3.gets,
              dropped: clients.length - live.length
            })
            closeClients(clients)
            await cluster.drain(600000)
          }
        }
        report.note(`The join cost of the real document, at a few users and at 100. \`pending edits = 0\` is a freshly compacted document; \`= 1\` is the same document after a single real edit, which is the state it is in almost all the time. The gap between the two rows at equal N is the sync cliff on real data, and \`cpu per sync\` is the per-joiner work that no amount of client-side caching avoids.\n\nArrivals above ${config.trace.joinRateAbove} are **ramped**, not simultaneous. Every join ships the whole ~51 MB document, so 100 at once means several GB of send buffers on one process — that stops measuring join cost and starts measuring how the process degrades under memory pressure. \`achieved (joins/s)\` is the number to plan a deploy against.`)
      }
    },
    {
      id: 'Y7.4',
      name: 'M users concurrently replaying the trace on one document',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const split = splitTrace()
        if (split == null) return skip(report)
        const { baseline, edits } = split
        const cluster = await getCluster()
        for (const mWriters of config.trace.writers) {
          const docid = `y74-${mWriters}`
          await seedTraced(cluster, docid, baseline.update)
          // ramped for the same reason as Y7.3: every one of these writers pulls
          // the whole ~51 MB document on join, so connecting them simultaneously
          // measures memory pressure rather than write cost
          const writers = await connectClients({
            count: mWriters,
            target: () => ({ port: cluster.ports[0], docid }),
            ratePerSecond: mWriters > config.trace.joinRateAbove ? config.trace.joinRate : 0
          })
          await cluster.mark()
          const started = performance.now()
          for (const edit of edits) {
            writers.forEach(w => w.send(updateFrame(edit.update)))
            await promise.wait(20)
          }
          await promise.wait(2000)
          const elapsed = performance.now() - started
          // drain before collecting, or the compactions this workload triggers
          // are still sitting behind `taskDebounce` and get reported as zero
          closeClients(writers)
          await cluster.drain(600000)
          const metrics = await cluster.collect()
          const total = edits.length * mWriters
          report.row({
            M: mWriters,
            'edits sent': total,
            'frames delivered': writers.reduce((a, w) => a + w.updatesReceived, 0),
            'bytes out (MB)': writers.reduce((a, w) => a + w.bytesReceived, 0) / MB,
            'time (ms)': elapsed,
            'serverCpu (ms)': metrics.server.cpuMs,
            'µs cpu per edit per writer': (metrics.server.cpuMs * 1000) / total,
            'loopDelay p99 (ms)': metrics.server.loopDelayP99Ms,
            'workerTime p95 (ms)': stats(metrics.tasks.map(t => t.durationMs)).p95,
            compactions: metrics.tasks.length,
            's3 written (MB)': metrics.worker.s3.putBytes / MB,
            dropped: writers.filter(w => w.dropped).length
          })
        }
        report.note('Everyone editing the same real document at once — writes and fan-out concentrated on one room, with a worker compacting ~51 MB behind them. `s3 written` against the bytes the clients actually sent is the amplification this document costs: each of these edits is a few hundred bytes and each compaction rewrites the whole thing.')
      }
    },
    {
      id: 'Y7.5',
      name: 'Compaction of the traced document',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const split = splitTrace()
        if (split == null) return skip(report)
        const { trace, baseline, edits } = split
        const cluster = await getCluster()
        const docid = 'y75-trace'
        const writer = await new RawClient({ port: cluster.ports[0], docid }).connect()
        await cluster.mark()
        writer.send(updateFrame(baseline.update))
        await cluster.awaitWrite({ docid })
        edits.forEach(e => writer.send(updateFrame(e.update)))
        await cluster.drain(600000)
        const m = await cluster.collect()
        const c = m.compactions[m.compactions.length - 1]
        report.row({
          'input (MB)': (baseline.update.byteLength + edits.reduce((a, e) => a + e.update.byteLength, 0)) / MB,
          'gcDoc (MB)': (c?.gcBytes ?? 0) / MB,
          'nongcDoc (MB)': (c?.nongcBytes ?? 0) / MB,
          'contentmap (KB)': (c?.contentmapBytes ?? 0) / 1024,
          compactions: m.tasks.length,
          'workerTime p95 (ms)': stats(m.tasks.map(t => t.durationMs)).p95,
          'workerTime max (ms)': stats(m.tasks.map(t => t.durationMs)).max,
          'workerMem peak (MB)': m.worker.rssPeakMB,
          's3 puts': m.worker.s3.puts,
          's3 written (MB)': m.worker.s3.putBytes / MB,
          taskErrors: m.tasks.filter(t => t.error).length
        })
        writer.close()
        report.note(`What one compaction of this document costs. The trace is \`gc: ${trace.gc}\` — it preserves deleted content — yet its gc and nongc encodings come out nearly identical, because the 34 human edits tombstone almost nothing next to the bulk import. Contrast Y5.3, where a synthetically churned document carries several times its live size in history: how much compaction costs you depends far more on the edit pattern than on the document size.`)
      }
    }
  ]
}
