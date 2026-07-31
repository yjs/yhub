import * as promise from 'lib0/promise'
import config from '../config.js'
import { getCluster } from '../cluster.js'
import { getFixture, makeCellUpdates, makeBatchUpdate, sizeLabel } from '../fixtures.js'
import { RawClient, updateFrame, connectClients, closeClients, measurePropagation } from '../client.js'
import { stats } from '../report.js'

/**
 * Y3: what does writing cost?
 *
 * Modelled on the actual pattern this deployment has: agents flushing batches,
 * humans making single edits.
 */

const KB = 1024
const MB = 1024 * 1024

/**
 * @param {import('../cluster.js').Cluster} cluster
 * @param {string} docid
 * @param {number} targetBytes
 */
const seedRoom = async (cluster, docid, targetBytes) => {
  if (targetBytes === 0) return
  const { gcUpdate } = getFixture({ targetBytes })
  const writer = await new RawClient({ port: cluster.ports[0], docid }).connect()
  writer.send(updateFrame(gcUpdate))
  await cluster.awaitWrite({ docid })
  writer.close()
  await cluster.drain(300000)
}

/**
 * @param {{ samples: Array<number>, lost: number }} prop
 */
export const propagationRow = ({ samples, lost }) => {
  if (samples.length === 0) {
    return { 'propagation p50 (ms)': '—', 'propagation p95 (ms)': '—', 'propagation p99 (ms)': '—', 'propagation max (ms)': '—', 'not delivered': lost }
  }
  const s = stats(samples)
  return {
    'propagation p50 (ms)': s.p50,
    'propagation p95 (ms)': s.p95,
    'propagation p99 (ms)': s.p99,
    'propagation max (ms)': s.max,
    'not delivered': lost
  }
}

export default {
  id: 'y3',
  title: 'Y3: What does writing cost?',
  benchmarks: [
    {
      id: 'Y3.1',
      name: 'One client writes N single-cell updates to a document of size S',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        const n = config.scale.singleEdits
        for (const targetBytes of config.scale.docSizes) {
          const docid = `y31-${sizeLabel(targetBytes)}`
          await seedRoom(cluster, docid, targetBytes)
          const updates = makeCellUpdates(n).map(updateFrame)
          const writer = await new RawClient({ port: cluster.ports[0], docid }).connect()
          const observer = await new RawClient({ port: cluster.ports[0], docid }).connect()
          await cluster.mark()
          const started = performance.now()
          updates.forEach(u => writer.send(u))
          await promise.wait(500)
          const elapsed = performance.now() - started
          const prop = await measurePropagation({ writer, observers: [observer], count: 20 })
          const m = await cluster.collect()
          const bytes = updates.reduce((a, u) => a + u.byteLength, 0)
          report.row({
            S: sizeLabel(targetBytes),
            N: n,
            'update (bytes)': bytes / n,
            'time (ms)': elapsed,
            'updates/s': n / (elapsed / 1000),
            'serverCpu (ms)': m.server.cpuMs,
            'µs cpu per update': (m.server.cpuMs * 1000) / n,
            ...propagationRow(prop),
            'loopDelay p99 (ms)': m.server.loopDelayP99Ms,
            streamLen: await cluster.streamLen({ org: config.hub.org, docid })
          })
          observer.close()
          writer.close()
          await cluster.drain()
        }
        report.note('The individual-edit case. `µs cpu per update` should be flat across S: a write is a buffer copy plus one `Y.createContentIdsFromUpdate` scan plus a Redis `XADD`, and no document is built (`src/server.js:778-788`). Any dependence on S here would refute tier B.')
      }
    },
    {
      id: 'Y3.2',
      name: 'One client flushes a batch of N cell edits as a single update',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        for (const cells of config.scale.batchCells) {
          const docid = `y32-${cells}`
          const update = makeBatchUpdate(cells)
          const writer = await new RawClient({ port: cluster.ports[0], docid }).connect()
          await cluster.mark()
          const started = performance.now()
          writer.send(updateFrame(update))
          await promise.wait(500)
          const elapsed = performance.now() - started
          const m = await cluster.collect()
          report.row({
            cells,
            'update (KB)': update.byteLength / KB,
            'bytes per cell': update.byteLength / cells,
            'time (ms)': elapsed,
            'serverCpu (ms)': m.server.cpuMs,
            'µs cpu per cell': (m.server.cpuMs * 1000) / cells,
            'loopDelay p99 (ms)': m.server.loopDelayP99Ms
          })
          writer.close()
          await cluster.drain()
        }
        report.note('The agent flush. Compare `µs cpu per cell` here against Y3.1: if batching is cheaper per cell, agents should batch aggressively, and the whole cost model shifts from update *count* to update *bytes*.')
      }
    },
    {
      id: 'Y3.3',
      name: 'M clients writing to M distinct documents',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        for (const m of config.scale.writers) {
          const writers = await connectClients({ count: m, target: i => ({ port: cluster.ports[0], docid: `y33-${m}-${i}` }) })
          const updates = makeCellUpdates(config.scale.writeRate).map(updateFrame)
          await cluster.mark()
          const started = performance.now()
          for (let tick = 0; tick < config.scale.writeRate; tick++) {
            writers.forEach(w => w.send(updates[tick]))
            await promise.wait(1000 / config.scale.writeRate)
          }
          await promise.wait(1000)
          const elapsed = performance.now() - started
          // drain first: compactions are claimed only after `taskDebounce`, so
          // collecting now would report none for a workload that does compact
          closeClients(writers)
          await cluster.drain(600000)
          const metrics = await cluster.collect()
          const total = m * config.scale.writeRate
          report.row({
            M: m,
            'updates sent': total,
            'time (ms)': elapsed,
            'serverCpu (ms)': metrics.server.cpuMs,
            'µs cpu per update': (metrics.server.cpuMs * 1000) / total,
            'loopDelay p99 (ms)': metrics.server.loopDelayP99Ms,
            'workerCpu (ms)': metrics.worker.cpuMs,
            compactions: metrics.tasks.length,
            'workerTime p95 (ms)': stats(metrics.tasks.map(t => t.durationMs)).p95
          })
        }
        report.note('Write throughput when load is spread over many rooms. Every write is its own room, so there is no fan-out: the expectation is that the worker binds before the server does, because each room is compacted independently.')
      }
    },
    {
      id: 'Y3.4',
      name: 'M clients writing to the same document',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        for (const m of config.scale.writers) {
          const docid = `y34-${m}`
          const writers = await connectClients({ count: m, target: () => ({ port: cluster.ports[0], docid }) })
          const updates = makeCellUpdates(config.scale.writeRate).map(updateFrame)
          await cluster.mark()
          const started = performance.now()
          for (let tick = 0; tick < config.scale.writeRate; tick++) {
            writers.forEach(w => w.send(updates[tick]))
            await promise.wait(1000 / config.scale.writeRate)
          }
          await promise.wait(1000)
          const elapsed = performance.now() - started
          const prop = await measurePropagation({ writer: writers[0], observers: writers.slice(1), count: 20 })
          const metrics = await cluster.collect()
          const total = m * config.scale.writeRate
          report.row({
            M: m,
            'updates sent': total,
            'frames delivered': writers.reduce((a, w) => a + w.updatesReceived, 0),
            'time (ms)': elapsed,
            'serverCpu (ms)': metrics.server.cpuMs,
            'µs cpu per update': (metrics.server.cpuMs * 1000) / total,
            ...propagationRow(prop),
            'loopDelay p99 (ms)': metrics.server.loopDelayP99Ms,
            dropped: writers.filter(w => w.dropped).length
          })
          closeClients(writers)
          await cluster.drain()
        }
        report.note('The same write load concentrated on one room, so every writer is also a subscriber. The gap against Y3.3 at equal M *is* the per-subscriber delivery cost — that is the number `messages × subscribers` is multiplied by.')
      }
    },
    {
      id: 'Y3.5',
      name: 'M agents flushing a batch simultaneously to one document',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        const cells = config.scale.batchCells[config.scale.batchCells.length - 1]
        for (const m of config.scale.writers) {
          const docid = `y35-${m}`
          const agents = await connectClients({ count: m, target: () => ({ port: cluster.ports[0], docid }) })
          const human = await new RawClient({ port: cluster.ports[0], docid }).connect()
          const humanObserver = await new RawClient({ port: cluster.ports[0], docid }).connect()
          const batches = agents.map((_, i) => updateFrame(makeBatchUpdate(cells, 700000 + i)))
          await cluster.mark()
          const started = performance.now()
          agents.forEach((a, i) => a.send(batches[i]))
          // a human editing the same document while the agents flush
          const prop = await measurePropagation({ writer: human, observers: [humanObserver], count: 20 })
          await promise.wait(2000)
          const elapsed = performance.now() - started
          const metrics = await cluster.collect()
          report.row({
            M: m,
            'cells per flush': cells,
            'flush (KB)': batches[0].byteLength / KB,
            'total in (MB)': (batches.reduce((a, b) => a + b.byteLength, 0)) / MB,
            'total out (MB)': agents.reduce((a, c) => a + c.bytesReceived, 0) / MB,
            'time (ms)': elapsed,
            'serverCpu (ms)': metrics.server.cpuMs,
            ...propagationRow(prop),
            'loopDelay p99 (ms)': metrics.server.loopDelayP99Ms,
            'loopDelay max (ms)': metrics.server.loopDelayMaxMs,
            dropped: agents.filter(a => a.dropped).length
          })
          human.close()
          humanObserver.close()
          closeClients(agents)
          await cluster.drain()
        }
        report.note('Bursty concentrated writes — the realistic worst case for an agent workload. `total out` against `total in` is the broadcast amplification. The propagation figures are a *separate* client making single small edits while the agents flush, i.e. what a human editing the same document feels; `loopDelay max` is the stall on the single relay thread that causes it.')
      }
    }
  ]
}
