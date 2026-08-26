import * as promise from 'lib0/promise'
import config from '../config.js'
import { getCluster } from '../cluster.js'
import { getFixture, makeCellUpdates, sizeLabel } from '../fixtures.js'
import { connectClients, closeClients, updateFrame, RawClient } from '../client.js'
import { stats } from '../report.js'

/**
 * Y2: what does a connected user cost?
 *
 * Answers "can I afford N connections" separately from "can I afford N
 * subscribers on one document" — they are different systems with different
 * bottlenecks, and a deployment sits somewhere between them.
 */

const MB = 1024 * 1024

/**
 * Seed a document of the given size by writing it through a client, then wait
 * for the worker to compact it. After this the document is in the state a real
 * document is in right after compaction: persisted, nothing pending.
 *
 * @param {import('../cluster.js').Cluster} cluster
 * @param {string} docid
 * @param {number} targetBytes
 */
const seedDoc = async (cluster, docid, targetBytes) => {
  if (targetBytes === 0) return
  const { gcUpdate } = getFixture({ targetBytes })
  const writer = await new RawClient({ port: cluster.ports[0], docid }).connect()
  writer.send(updateFrame(gcUpdate))
  await cluster.awaitWrite({ docid })
  writer.close()
  await cluster.drain(300000)
}

/**
 * Server RSS with nothing connected. Every per-connection figure is reported
 * against this, because the process baseline (~140 MB of uws, node and the
 * compute pool) would otherwise dominate the marginal cost at small N.
 *
 * @param {import('../cluster.js').Cluster} cluster
 */
const baselineRss = async cluster => {
  await promise.wait(500)
  await cluster.mark()
  return (await cluster.collect()).server.rssEndMB
}

/**
 * @param {Array<RawClient>} clients
 */
const syncStats = clients => {
  const s = stats(clients.filter(c => !c.dropped).map(c => c.syncTimeMs))
  return {
    'syncTime p50 (ms)': s.p50,
    'syncTime p95 (ms)': s.p95,
    'syncTime p99 (ms)': s.p99,
    'syncTime max (ms)': s.max,
    dropped: clients.filter(c => c.dropped).length
  }
}

export default {
  id: 'y2',
  title: 'Y2: What does a connected user cost?',
  benchmarks: [
    {
      id: 'Y2.1',
      name: 'Connect N clients to N distinct empty documents',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        const baseline = await baselineRss(cluster)
        for (const n of config.scale.connections) {
          await cluster.mark()
          const started = performance.now()
          const clients = await connectClients({ count: n, target: i => ({ port: cluster.ports[0], docid: `y21-${n}-${i}` }) })
          const elapsed = performance.now() - started
          const m = await cluster.collect()
          report.row({
            N: n,
            'time (ms)': elapsed,
            'conn/s': n / (elapsed / 1000),
            ...syncStats(clients),
            'serverMem rss (MB)': m.server.rssEndMB,
            'above baseline (MB)': m.server.rssEndMB - baseline,
            'MB per doc': (m.server.rssEndMB - baseline) / n,
            'serverCpu (ms)': m.server.cpuMs
          })
          closeClients(clients)
          await promise.wait(500)
        }
        report.note(`Each connection is also a new document, so this is the per-connection **and** per-document floor. Server baseline with nothing connected: ${baseline.toFixed(1)} MB. Compare \`MB per doc\` against Y2.2, where all N share one document: the difference is the cost of a document.`)
      }
    },
    {
      id: 'Y2.2',
      name: 'Connect N clients to one empty document',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        const baseline = await baselineRss(cluster)
        for (const n of config.scale.connections) {
          await cluster.mark()
          const started = performance.now()
          const clients = await connectClients({ count: n, target: () => ({ port: cluster.ports[0], docid: `y22-${n}` }) })
          const elapsed = performance.now() - started
          const m = await cluster.collect()
          report.row({
            N: n,
            'time (ms)': elapsed,
            'conn/s': n / (elapsed / 1000),
            ...syncStats(clients),
            'serverMem rss (MB)': m.server.rssEndMB,
            'above baseline (MB)': m.server.rssEndMB - baseline,
            'MB per connection': (m.server.rssEndMB - baseline) / n,
            'serverCpu (ms)': m.server.cpuMs
          })
          closeClients(clients)
          await promise.wait(500)
        }
        report.note(`One \`WSUser\` and one socket per connection; no \`Y.Doc\` per connection or per document, and no document cache anywhere in the heap. Server baseline with nothing connected: ${baseline.toFixed(1)} MB.`)
      }
    },
    {
      id: 'Y2.3',
      name: 'Idle: hold N connections with no traffic',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        const n = config.scale.connections[config.scale.connections.length - 1]
        const clients = await connectClients({ count: n, target: i => ({ port: cluster.ports[0], docid: `y23-${i % 10}` }) })
        await cluster.mark()
        const before = (await cluster.collect()).server.rssEndMB
        await promise.wait(config.scale.holdMs)
        const m = await cluster.collect()
        report.row({
          N: n,
          'hold (s)': config.scale.holdMs / 1000,
          'rss start (MB)': before,
          'rss end (MB)': m.server.rssEndMB,
          'drift (MB)': m.server.rssEndMB - before,
          'serverCpu (ms)': m.server.cpuMs,
          'cpu per conn per s (µs)': (m.server.cpuMs * 1000) / n / (config.scale.holdMs / 1000),
          dropped: clients.filter(c => c.dropped).length
        })
        closeClients(clients)
        report.note('Confirms idle connections are genuinely tier A and that nothing accumulates. Any sustained positive drift here is a leak, and would compound over a deployment\'s uptime rather than over its load.')
      }
    },
    {
      id: 'Y2.4',
      name: 'Connect N clients to one document of size S, all at once',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        // capped separately from `connections`: a simultaneous join holds the
        // whole document per joiner on both sides of the socket, so this is the
        // one sweep bounded by RAM rather than by CPU
        const n = Math.min(
          config.scale.connections[config.scale.connections.length - 1],
          config.scale.joinStormMax
        )
        for (const targetBytes of config.scale.docSizes) {
          const docid = `y24-${sizeLabel(targetBytes)}`
          await seedDoc(cluster, docid, targetBytes)
          await cluster.flushCache()
          await cluster.mark()
          const started = performance.now()
          const clients = await connectClients({ count: n, target: () => ({ port: cluster.ports[0], docid }) })
          const elapsed = performance.now() - started
          const m = await cluster.collect()
          const docMB = (clients[0]?.syncBytes ?? 0) / MB
          report.row({
            N: n,
            S: sizeLabel(targetBytes),
            'syncBytes (MB)': docMB,
            'time (ms)': elapsed,
            ...syncStats(clients),
            'serverMem peak (MB)': m.server.rssPeakMB,
            'peak MB per concurrent sync': targetBytes > 0 ? m.server.rssPeakMB / n / docMB : '—',
            'arrayBuffers (MB)': m.server.arrayBuffersMB,
            'serverCpu (ms)': m.server.cpuMs,
            'loopDelay p99 (ms)': m.server.loopDelayP99Ms,
            queueDepth: m.server.queueDepthMax,
            's3 gets': m.server.s3.gets
          })
          closeClients(clients)
          await promise.wait(500)
        }
        report.note('Capped at `scale.joinStormMax` = ' + config.scale.joinStormMax + ' joiners, separately from the rest of the `connections` sweep: `peak MB per concurrent sync` below is per joiner **per MB of document**, so this is the one measurement bounded by RAM rather than CPU. Y2.5 is where larger populations are covered, by ramping them.\n\nThe join storm: a deploy, a load-balancer failover, or everyone opening the same document at 09:00. The fetch, the state-vector scan and the merge are identical across concurrent joiners of the same document and are nevertheless recomputed for each one (`src/server.js:740-764`). The bytes sent are inherent; this work is not. `queueDepth` is the compute pool\'s unbounded queue, which holds full payloads.')
      }
    },
    {
      id: 'Y2.5',
      name: 'Connect N clients to one document of size S, ramped at r conn/s',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        // see `scale.rampMax`: ramping only bounds memory while the target rate
        // is near what the server can serve, so this population is capped too
        const n = Math.min(
          config.scale.connections[config.scale.connections.length - 1],
          config.scale.rampMax
        )
        const targetBytes = config.scale.docSizes[config.scale.docSizes.length - 1]
        const docid = `y25-${sizeLabel(targetBytes)}`
        await seedDoc(cluster, docid, targetBytes)
        for (const rate of config.scale.joinRates) {
          await cluster.flushCache()
          await cluster.mark()
          const started = performance.now()
          const clients = await connectClients({ count: n, target: () => ({ port: cluster.ports[0], docid }), ratePerSecond: rate })
          const elapsed = performance.now() - started
          const m = await cluster.collect()
          report.row({
            N: n,
            S: sizeLabel(targetBytes),
            'target (conn/s)': rate,
            'achieved (conn/s)': n / (elapsed / 1000),
            ...syncStats(clients),
            'serverMem peak (MB)': m.server.rssPeakMB,
            'loopDelay p99 (ms)': m.server.loopDelayP99Ms,
            queueDepth: m.server.queueDepthMax
          })
          closeClients(clients)
          await promise.wait(500)
        }
        report.note('The join rate one server sustains at this document size. Directly actionable: it is the number that says how fast you may roll a deploy. Where `achieved` falls below `target`, the server is the limit rather than the ramp.')
      }
    },
    {
      id: 'Y2.6',
      name: 'Sync a document of size S with k pending stream updates',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        const targetBytes = config.scale.docSizes[config.scale.docSizes.length - 1]
        for (const k of config.scale.pendingUpdates) {
          const docid = `y26-${k}`
          await seedDoc(cluster, docid, targetBytes)
          // write k updates and do NOT let the worker compact them, so the
          // document is in the state an actively edited document is always in
          const writer = await new RawClient({ port: cluster.ports[0], docid }).connect()
          makeCellUpdates(k).forEach(u => writer.send(updateFrame(u)))
          await promise.wait(300)
          const streamLen = await cluster.streamLen({ org: config.hub.org, docid })
          const pgRows = await cluster.pgRows({ docid })
          await cluster.flushCache()
          await cluster.mark()
          const clients = await connectClients({ count: 10, target: () => ({ port: cluster.ports[0], docid }) })
          const m = await cluster.collect()
          report.row({
            S: sizeLabel(targetBytes),
            k,
            streamLen,
            pgRows,
            ...syncStats(clients),
            'serverCpu (ms)': m.server.cpuMs,
            'cpu per sync (ms)': m.server.cpuMs / clients.length,
            's3 gets': m.server.s3.gets,
            's3 gets per sync': m.server.s3.gets / clients.length
          })
          closeClients(clients)
          writer.close()
          await cluster.drain()
        }
        report.note('The sync cliff, over the network. Y1.1 showed the merge jumps to full price at the first pending update; this is the same effect end to end, plus the `pgRows` effect — every uncompacted row is an extra S3 GET on every sync.')
      }
    }
  ]
}
