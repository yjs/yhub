import * as promise from 'lib0/promise'
import config from '../config.js'
import { getCluster } from '../cluster.js'
import { makeCellUpdates } from '../fixtures.js'
import { RawClient, connectClients, closeClients, updateFrame, measurePropagation, awarenessFrame, awarenessStates } from '../client.js'
import { propagationRow } from './y3-writes.js'

/**
 * Y4: what does an observer cost?
 *
 * Broadcast costs `messages × subscribers` no matter how it is built — that is
 * the problem, not a flaw in the solution. These benchmarks hold the write rate
 * fixed and vary only the audience, to measure the **per-subscriber constant**,
 * which is the part a design can actually change.
 */

const EDITS = 50

/**
 * Send `EDITS` updates into a document and report what the fan-out cost.
 *
 * @param {import('../cluster.js').Cluster} cluster
 * @param {RawClient} writer
 * @param {Array<RawClient>} observers
 * @param {(tick: number) => void} [alsoEachTick]
 */
const driveEdits = async (cluster, writer, observers, alsoEachTick) => {
  const updates = makeCellUpdates(EDITS).map(updateFrame)
  await cluster.mark()
  const started = performance.now()
  for (let i = 0; i < EDITS; i++) {
    writer.send(updates[i])
    alsoEachTick?.(i)
    await promise.wait(20)
  }
  await promise.wait(1000)
  const elapsed = performance.now() - started
  const metrics = await cluster.collect()
  return { elapsed, metrics }
}

export default {
  id: 'y4',
  title: 'Y4: What does an observer cost?',
  benchmarks: [
    {
      id: 'Y4.1',
      name: 'One writer, N observers on one document',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        for (const n of config.scale.observers) {
          const docid = `y41-${n}`
          const writer = await new RawClient({ port: cluster.ports[0], docid }).connect()
          const observers = await connectClients({ count: n, target: () => ({ port: cluster.ports[0], docid }) })
          const { elapsed, metrics } = await driveEdits(cluster, writer, observers)
          const prop = await measurePropagation({ writer, observers, count: 20 })
          report.row({
            N: n,
            edits: EDITS,
            'time (ms)': elapsed,
            'frames delivered': observers.reduce((a, o) => a + o.updatesReceived, 0),
            'bytes out (KB)': observers.reduce((a, o) => a + o.bytesReceived, 0) / 1024,
            'serverCpu (ms)': metrics.server.cpuMs,
            'µs cpu per update per observer': (metrics.server.cpuMs * 1000) / EDITS / n,
            ...propagationRow(prop),
            'loopDelay p99 (ms)': metrics.server.loopDelayP99Ms
          })
          closeClients(observers)
          writer.close()
          await cluster.drain()
        }
        report.note('Expected linear in N; the constant is what matters. y/hub merges and encodes the batch **once per subscriber** rather than once per batch (`src/server.js:633`), so it spends CPU where it only needed to spend bandwidth. That is a constant factor, not a worse curve — but a removable one. Divide a core-second by `µs cpu per update per observer` to get the observers one server sustains per update/s.')
      }
    },
    {
      id: 'Y4.2',
      name: 'One writer, N observers, with awareness enabled',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        for (const n of config.scale.observers) {
          const docid = `y42-${n}`
          const writer = await new RawClient({ port: cluster.ports[0], docid }).connect()
          const observers = await connectClients({ count: n, target: () => ({ port: cluster.ports[0], docid }) })
          // every observer is also present, as a real participant would be
          observers.forEach((o, i) => o.send(awarenessFrame(i + 1, 1, awarenessStates.large)))
          await promise.wait(500)
          let clock = 2
          const { elapsed, metrics } = await driveEdits(cluster, writer, observers, () => {
            observers.forEach((o, i) => o.send(awarenessFrame(i + 1, clock, awarenessStates.large)))
            clock++
          })
          const prop = await measurePropagation({ writer, observers, count: 20 })
          report.row({
            N: n,
            edits: EDITS,
            'time (ms)': elapsed,
            'awareness frames in': EDITS * n,
            'awareness frames out': observers.reduce((a, o) => a + o.awarenessReceived, 0),
            'serverCpu (ms)': metrics.server.cpuMs,
            'µs cpu per update per observer': (metrics.server.cpuMs * 1000) / EDITS / n,
            ...propagationRow(prop),
            'loopDelay p99 (ms)': metrics.server.loopDelayP99Ms,
            dropped: observers.filter(o => o.dropped).length
          })
          closeClients(observers)
          writer.close()
          await cluster.drain()
        }
        report.note('The same load as Y4.1 with every observer also emitting presence. The difference against Y4.1 is the price of presence. Merging awareness `JSON.parse`s every participant state and `JSON.stringify`s every state of the merged result, once per subscriber — where a document update is a memcpy.')
      }
    },
    {
      id: 'Y4.3',
      name: 'N clients emitting presence at 1 Hz, no document edits',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        const ticks = Math.max(3, Math.round(config.scale.holdMs / 1000 / 3))
        for (const stateName of /** @type {Array<'small'|'large'>} */ (['small', 'large'])) {
          for (const n of config.scale.observers) {
            const docid = `y43-${stateName}-${n}`
            const clients = await connectClients({ count: n, target: () => ({ port: cluster.ports[0], docid }) })
            await cluster.mark()
            const started = performance.now()
            for (let tick = 0; tick < ticks; tick++) {
              clients.forEach((c, i) => c.send(awarenessFrame(i + 1, tick + 1, awarenessStates[stateName])))
              await promise.wait(1000 / config.scale.awarenessRate)
            }
            await promise.wait(1000)
            const elapsed = performance.now() - started
            const metrics = await cluster.collect()
            const sent = ticks * n
            report.row({
              state: stateName,
              N: n,
              ticks,
              'frames in': sent,
              'frames out': clients.reduce((a, c) => a + c.awarenessReceived, 0),
              'time (ms)': elapsed,
              'serverCpu (ms)': metrics.server.cpuMs,
              'cpu utilisation (%)': (metrics.server.cpuMs / elapsed) * 100,
              'µs cpu per presence tick': (metrics.server.cpuMs * 1000) / sent,
              'loopDelay p99 (ms)': metrics.server.loopDelayP99Ms,
              dropped: clients.filter(c => c.dropped).length
            })
            closeClients(clients)
            await promise.wait(300)
          }
        }
        report.note('Awareness alone: the batch is largest relative to the payload, and the per-subscriber JSON constant is least diluted by anything else. `cpu utilisation` is the fraction of one core the relay thread is spending purely on presence — at 100% the event loop is saturated and every other operation on that pod queues behind it.')
      }
    },
    {
      id: 'Y4.4',
      name: 'Y4.1 across 2 and 3 server processes',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const n = config.scale.observers[config.scale.observers.length - 1]
        for (const servers of [1, 2, 3]) {
          const cluster = await getCluster({ servers })
          const docid = `y44-${servers}`
          const writer = await new RawClient({ port: cluster.ports[0], docid }).connect()
          // spread the observers evenly over the pods, all on the same document
          const observers = await connectClients({ count: n, target: i => ({ port: cluster.ports[i % servers], docid }) })
          const { elapsed, metrics } = await driveEdits(cluster, writer, observers)
          const prop = await measurePropagation({ writer, observers, count: 20 })
          report.row({
            servers,
            N: n,
            'observers per server': n / servers,
            'time (ms)': elapsed,
            'frames delivered': observers.reduce((a, o) => a + o.updatesReceived, 0),
            'serverCpu total (ms)': metrics.server.cpuMs,
            'serverCpu per server (ms)': metrics.server.cpuMs / servers,
            ...propagationRow(prop),
            'loopDelay p99 worst pod (ms)': metrics.server.loopDelayP99Ms
          })
          closeClients(observers)
          writer.close()
          await cluster.drain()
        }
        report.note('Confirms fan-out cost partitions across pods: total CPU should stay roughly flat while per-pod CPU and the worst pod\'s event-loop delay fall with the number of servers. This is what justifies "add a server" as the remedy for the awareness cost in Y4.2 and Y4.3. Note that all pods share one Redis, and the Redis read is shared across all documents in a process (`src/stream.js:292`).')
      }
    }
  ]
}
