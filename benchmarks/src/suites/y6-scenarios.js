import * as promise from 'lib0/promise'
import config from '../config.js'
import { getCluster } from '../cluster.js'
import { getFixture, makeBatchUpdate, sizeLabel } from '../fixtures.js'
import { RawClient, connectClients, closeClients, updateFrame, measurePropagation, awarenessFrame, awarenessStates } from '../client.js'
import { stats } from '../report.js'
import { propagationRow } from './y3-writes.js'

/**
 * Y6: the target scenario.
 *
 * Composed from the groups above once their constants are known, to check that
 * the model predicts reality. One driver, six configurations — if a row here
 * disagrees with what Y1–Y5 predict, the model is wrong somewhere and the
 * disagreement is the finding.
 */

const MB = 1024 * 1024

/**
 * @param {object} opts
 * @param {string} opts.tag
 * @param {number} opts.users
 * @param {number} opts.docs
 * @param {number} opts.docSize
 * @param {boolean} [opts.awareness]
 * @param {number} [opts.servers]
 * @param {number} [opts.workers]
 * @param {number} [opts.editsPerUser]
 * @param {number} [opts.cellsPerEdit]
 */
const scenario = async ({ tag, users, docs, docSize, awareness = false, servers = 1, workers = 1, editsPerUser = config.scale.scenario.editRounds, cellsPerEdit = config.scale.scenario.cellsPerEdit }) => {
  const cluster = await getCluster({ servers, workers })
  const docids = Array.from({ length: docs }, (_, i) => `${tag}-${i}`)

  // seed every document to the target size before anyone connects
  if (docSize > 0) {
    const { gcUpdate } = getFixture({ targetBytes: docSize })
    for (const docid of docids) {
      const seeder = await new RawClient({ port: cluster.ports[0], docid }).connect()
      seeder.send(updateFrame(gcUpdate))
      await cluster.awaitWrite({ docid })
      seeder.close()
    }
    await cluster.drain(300000)
  }
  await cluster.flushCache()
  await cluster.mark()

  const started = performance.now()
  const clients = await connectClients({
    count: users,
    target: i => ({ port: cluster.ports[i % servers], docid: docids[i % docs] })
  })
  const connectedAt = performance.now()

  if (awareness) {
    clients.forEach((c, i) => c.send(awarenessFrame(i + 1, 1, awarenessStates.large)))
    await promise.wait(500)
  }

  // agent-flush write pattern: each user flushes a batch of cell edits
  for (let round = 0; round < editsPerUser; round++) {
    clients.forEach((c, i) => c.send(updateFrame(makeBatchUpdate(cellsPerEdit, 1000000 + round * users + i))))
    if (awareness) clients.forEach((c, i) => c.send(awarenessFrame(i + 1, round + 2, awarenessStates.large)))
    await promise.wait(500)
  }
  await promise.wait(1000)

  // only clients that share the writer's room can observe its edit: users are
  // assigned round-robin, so those are the ones whose index is a multiple of
  // `docs`. In the fully spread case (docs === users) there are none.
  const writer = clients[0]
  const roomMates = clients.filter((_, i) => i > 0 && i % docs === 0).slice(0, 50)
  const prop = await measurePropagation({ writer, observers: roomMates, count: 10 })
  const elapsed = performance.now() - started
  // Drain *before* collecting: a compaction is only claimed after `taskDebounce`,
  // so collecting first would report zero worker activity for a workload that
  // does in fact compact.
  closeClients(clients)
  await cluster.drain(600000)
  const m = await cluster.collect()

  const row = {
    users,
    docs,
    S: sizeLabel(docSize),
    awareness: awareness ? 'yes' : 'no',
    servers,
    workers,
    'connect+sync (ms)': connectedAt - started,
    'syncTime p50 (ms)': stats(clients.filter(c => !c.dropped).map(c => c.syncTimeMs)).p50,
    'syncTime p99 (ms)': stats(clients.filter(c => !c.dropped).map(c => c.syncTimeMs)).p99,
    'syncTime max (ms)': stats(clients.filter(c => !c.dropped).map(c => c.syncTimeMs)).max,
    'bytes out (MB)': clients.reduce((a, c) => a + c.bytesReceived, 0) / MB,
    ...propagationRow(prop),
    'serverMem peak (MB)': m.server.rssPeakMB,
    'serverCpu (ms)': m.server.cpuMs,
    'loopDelay p99 (ms)': m.server.loopDelayP99Ms,
    queueDepth: m.server.queueDepthMax,
    'workerMem peak (MB)': m.worker.rssPeakMB,
    'workerTime p95 (ms)': stats(m.tasks.map(t => t.durationMs)).p95,
    compactions: m.tasks.length,
    's3 written (MB)': m.worker.s3.putBytes / MB,
    dropped: clients.filter(c => c.dropped).length,
    'total (s)': elapsed / 1000
  }
  return row
}

const { users, docSize, docCounts, agents } = config.scale.scenario

export default {
  id: 'y6',
  title: 'Y6: The target scenario',
  benchmarks: [
    {
      id: 'Y6.1',
      name: 'Users across as many documents, agent-flush write pattern',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        report.row(await scenario({ tag: 'y61', users, docs: docCounts[0], docSize }))
        report.note('The spread case: everyone in their own document. No fan-out at all, so this isolates the per-connection and per-room costs plus the worker load of many independent compactions. If your load looks like this, y/hub\'s design is well matched to it and the expected bottleneck is Redis and Postgres rather than the server process.')
      }
    },
    {
      id: 'Y6.2',
      name: 'All users on one document, with and without awareness',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        report.row(await scenario({ tag: 'y62a', users, docs: 1, docSize, awareness: false }))
        report.row(await scenario({ tag: 'y62b', users, docs: 1, docSize, awareness: true }))
        report.note('The concentrated case, and the hard one. Everything is `messages × subscribers`, every joiner independently fetches, merges and scans the same document, and the awareness row adds a JSON round-trip per participant state per subscriber on top. The gap between the two rows is the price of presence on a large shared document.')
      }
    },
    {
      id: 'Y6.3',
      name: 'Users across a moderate number of documents',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        report.row(await scenario({ tag: 'y63', users, docs: docCounts[1], docSize }))
        report.note('A plausible real distribution — teams of ten or so per document.')
      }
    },
    {
      id: 'Y6.4',
      name: 'Users across a few documents',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        report.row(await scenario({ tag: 'y64', users, docs: docCounts[2], docSize }))
        report.note('Locates the crossover between Y6.1 and Y6.2 — the point where fan-out starts to dominate the per-connection floor.')
      }
    },
    {
      id: 'Y6.5',
      name: 'Y6.2 across 3 server processes and 3 workers',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        report.row(await scenario({ tag: 'y65', users, docs: 1, docSize, awareness: true, servers: 3, workers: 3 }))
        report.note('What it takes to make the hard case work, and therefore the scaling recommendation. Compare against the awareness row of Y6.2: per-pod CPU and event-loop delay should fall roughly with the number of pods, because fan-out partitions. The joins do not partition — every pod still fetches and merges the document for every one of its own joiners.\n\n**This is the only benchmark that runs more than one worker, and it surfaces a real hazard.** `taskDebounce` is the `XAUTOCLAIM` min-idle-time (`src/stream.js:538`), so if a compaction takes longer than `taskDebounce`, a second worker reclaims the task while the first is still running it. Both then persist the same room and the loser dies on `duplicate key value violates unique constraint`. A single-worker deployment can never hit this, which is why nothing else here sees it. The rule is **`taskDebounce` must exceed your worst-case compaction time** — at 20 MB that is seconds, and this suite therefore runs 10s rather than 1s.')
      }
    },
    {
      id: 'Y6.6',
      name: 'Agents each building a document concurrently',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        const target = config.scale.growthTarget
        const cellsPerChunk = Math.max(1, Math.round(config.scale.growthChunk / 42))
        await cluster.mark()
        const started = performance.now()
        const writers = await connectClients({ count: agents, target: i => ({ port: cluster.ports[0], docid: `y66-${i}` }) })
        let written = 0
        let seq = 0
        while (written < target) {
          const update = makeBatchUpdate(cellsPerChunk, 1200000 + seq++)
          writers.forEach(w => w.send(updateFrame(update)))
          written += update.byteLength
          await promise.wait(20)
        }
        const writeMs = performance.now() - started
        const drained = await cluster.drain(600000)
        const m = await cluster.collect()
        const totalWrittenMB = (written * agents) / MB
        report.row({
          agents,
          'target each (MB)': target / MB,
          'written by clients (MB)': totalWrittenMB,
          'write time (s)': writeMs / 1000,
          'drain time (s)': (performance.now() - started - writeMs) / 1000,
          compactions: m.tasks.length,
          'workerTime p95 (ms)': stats(m.tasks.map(t => t.durationMs)).p95,
          'workerMem peak (MB)': m.worker.rssPeakMB,
          's3 puts': m.worker.s3.puts,
          's3 written (MB)': m.worker.s3.putBytes / MB,
          'write amplification': (m.worker.s3.putBytes / MB) / totalWrittenMB,
          'streamLen max': await cluster.streamLen({ org: config.hub.org, docid: 'y66-0' }),
          drained: drained ? 'yes' : 'no'
        })
        closeClients(writers)
        report.note('The agent workload at scale — Y5.1 multiplied. This is likely the binding constraint for an agent-heavy deployment, and it is a **worker** constraint rather than a server one: the writes themselves are cheap, but every one of them triggers another whole-document rewrite. `drained: no` means compaction never caught up within the timeout.')
      }
    }
  ]
}
