import { fork } from 'node:child_process'
import * as Y from '@y/y'
import * as promise from 'lib0/promise'
import { mergeUpdates } from '../../../src/y-utils.js'
import { createComputePool } from '../../../src/compute.js'
import { mergeAwarenessUpdates } from '../../../src/protocol.js'
import config from './../config.js'
import { getFixture, makeCellUpdates, sizeLabel } from '../fixtures.js'
import { timeIt, timeItAsync, measureRetainedHeap } from '../measure.js'
import { awarenessUpdate, awarenessStates } from '../client.js'

/**
 * Y1: primitive costs. No network, no databases, seconds to run.
 *
 * These establish the constants every other group is interpreted against, and
 * several of the tier grades in README section B stand or fall here. If Y1.5 or
 * Y1.2 is bad enough on its own, the answer is visible at a fraction of the
 * effort of a full load test.
 */

const MB = 1024 * 1024

/**
 * Y1.1 — binary merge of a document of size S with k pending updates.
 *
 * This is *merge pending updates on sync*, the term the sync cost is dominated
 * by for any actively edited document. `Y.mergeUpdates` returns its input
 * unchanged when given exactly one update, so k=0 — a freshly compacted document
 * with nothing pending — is free. The cliff is the step to k=1: one pending
 * update means the whole document is decoded and re-encoded, and k=100 costs
 * about the same as k=1 because the pending updates are tiny beside it.
 *
 * Exported so Y1.7 can re-run it in a process with the native merge enabled.
 */
export const runY11 = () => {
  /** @type {Array<{[k: string]: number|string}>} */
  const rows = []
  for (const targetBytes of config.scale.primitiveDocSizes) {
    const { gcUpdate } = getFixture({ targetBytes })
    for (const k of config.scale.pendingUpdates) {
      const pending = makeCellUpdates(k)
      const updates = [gcUpdate, ...pending]
      const time = timeIt(() => mergeUpdates(false, updates))
      rows.push({
        S: sizeLabel(targetBytes),
        k,
        'time (ms)': time,
        'throughput (MB/s)': time > 0 ? (gcUpdate.byteLength / MB) / (time / 1000) : Infinity
      })
    }
  }
  return rows
}

/**
 * Y1.4 — document merge: build a real `Y.Doc` from a size-S update and
 * re-encode it. This is the core of compaction (`src/y-utils.js:35-44` takes
 * this path whenever gc is required), and it yields the **`Y.Doc` expansion
 * factor**: heap bytes per serialized byte. That factor sizes workers, and the
 * same number applies in a browser, so it also says what a 40 MB document costs
 * a customer's client.
 */
export const runY14 = () => {
  /** @type {Array<{[k: string]: number|string}>} */
  const rows = []
  for (const targetBytes of config.scale.primitiveDocSizes) {
    const { gcUpdate } = getFixture({ targetBytes })
    const time = timeIt(() => mergeUpdates(true, [gcUpdate, ...makeCellUpdates(2)]))
    const { result, heapMB, externalMB, totalMB } = measureRetainedHeap(() => {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, gcUpdate)
      return doc
    })
    result.destroy()
    rows.push({
      S: sizeLabel(targetBytes),
      'docSize (MB)': gcUpdate.byteLength / MB,
      'time (ms)': time,
      'throughput (MB/s)': (gcUpdate.byteLength / MB) / (time / 1000),
      'Y.Doc heap (MB)': heapMB,
      'Y.Doc external (MB)': externalMB,
      'expansion factor': totalMB / (gcUpdate.byteLength / MB)
    })
  }
  return rows
}

/**
 * Run Y1.1 and Y1.4 again in a child process with the native yrs merge enabled.
 * `src/y-utils.js:6` reads the flag once at module load, so the comparison
 * cannot be made inside one process.
 */
const runNative = () => promise.create((resolve, reject) => {
  const child = fork(new URL('../proc/y-native.js', import.meta.url).pathname, [], {
    env: { ...process.env, USE_Y_NATIVE: '1' },
    execArgv: ['--expose-gc', '--max-old-space-size=8192'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  })
  child.on('message', /** @param {any} m */ m => { child.kill(); resolve(m) })
  child.on('error', reject)
  child.on('exit', code => code !== 0 && reject(new Error(`y-native child exited with ${code}`)))
})

export default {
  id: 'y1',
  title: 'Y1: Primitive costs',
  benchmarks: [
    {
      id: 'Y1.1',
      name: 'Binary-merge a document of size S with k pending updates',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        runY11().forEach(r => report.row(r))
        report.note('`k` is the number of updates written since the last compaction. **The cliff is at the very first one.** With k=0 the merge is a single update and `Y.mergeUpdates` returns it unchanged; with k=1 the full document is decoded and re-encoded, and k=100 costs the same as k=1 because the pending updates are tiny next to the document. So a single cell edit since the last compaction makes every subsequent sync pay the full price — a benchmark that syncs only freshly compacted documents measures the first row of each block and misses the dominant term entirely.')
      }
    },
    {
      id: 'Y1.2',
      name: 'Compute the state vector of a document of size S',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        for (const targetBytes of config.scale.primitiveDocSizes) {
          const { gcUpdate } = getFixture({ targetBytes })
          const time = timeIt(() => Y.encodeStateVectorFromUpdate(gcUpdate))
          report.row({
            S: sizeLabel(targetBytes),
            'docSize (MB)': gcUpdate.byteLength / MB,
            'time (ms)': time,
            'throughput (MB/s)': (gcUpdate.byteLength / MB) / (time / 1000),
            offloaded: gcUpdate.byteLength >= 512 * 1024 ? 'yes' : 'no'
          })
        }
        report.note('Paid once per connection on every sync. `src/compute.js:313` asserts ~30–40 MB/s and uses it to justify the 512 KB inline/offload threshold — the `offloaded` column shows which side of that threshold each size falls on.')
      }
    },
    {
      id: 'Y1.3',
      name: 'Create content IDs from an update of size U',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        for (const cells of config.scale.batchCells) {
          const update = makeCellUpdates(1, { cellsPerUpdate: cells })[0]
          const time = timeIt(() => Y.createContentIdsFromUpdate(update))
          report.row({
            cells,
            'U (KB)': update.byteLength / 1024,
            'time (ms)': time,
            'throughput (MB/s)': (update.byteLength / MB) / (time / 1000)
          })
        }
        report.note('Runs on the main thread for every inbound message (`src/server.js:786`). Linear in the update, independent of document size — this is what makes writing tier B.')
      }
    },
    {
      id: 'Y1.4',
      name: 'Document-merge: build a Y.Doc from size S and re-encode',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        runY14().forEach(r => report.row(r))
        report.note('The `expansion factor` is heap bytes per serialized byte — the single most important constant for sizing workers, and the one that says what a document costs in a browser.')
      }
    },
    {
      id: 'Y1.5',
      name: 'Merge a batch of N awareness updates',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        for (const stateName of /** @type {Array<'small'|'large'>} */ (['small', 'large'])) {
          const state = awarenessStates[stateName]
          for (const n of config.scale.observers) {
            const updates = Array.from({ length: n }, (_, i) => awarenessUpdate(i + 1, 1, state))
            const bytes = updates.reduce((a, u) => a + u.byteLength, 0)
            const time = timeIt(() => mergeAwarenessUpdates(updates))
            report.row({
              state: stateName,
              N: n,
              'input (KB)': bytes / 1024,
              'time (ms)': time,
              'µs per state': (time * 1000) / n,
              'server total for N subscribers (ms)': time * n
            })
          }
        }
        report.note('This runs **once per subscriber per batch** (`src/server.js:636`), where a document update is a memcpy. Cost is dominated by a `JSON.parse` of every participant state and a `JSON.stringify` of every state of the merged result (`@y/protocols/src/awareness.js`), plus a throwaway `Awareness` + `Y.Doc` per call (`src/protocol.js:25`) — which is why `µs per state` is so high at N=1 and falls as the fixed cost is amortised. The last column is the number that matters: N participants present in a document means N states to merge **and** N subscribers to merge them for, so one presence tick costs the server `time × N` on a single thread.')
      }
    },
    {
      id: 'Y1.6',
      name: 'Structured-clone a buffer of size S to a compute worker',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const pool = createComputePool({ poolSize: 1 })
        try {
          for (const targetBytes of config.scale.primitiveDocSizes) {
            const { gcUpdate } = getFixture({ targetBytes })
            const clone = timeIt(() => structuredClone(gcUpdate))
            const local = timeIt(() => Y.encodeStateVectorFromUpdate(gcUpdate))
            const roundTrip = await timeItAsync(() => pool.run({ type: 'computeStateVector', update: gcUpdate }, [], {}))
            report.row({
              S: sizeLabel(targetBytes),
              'clone (ms)': clone,
              'local scan (ms)': local,
              'pool round-trip (ms)': roundTrip,
              'clone rate (MB/s)': (gcUpdate.byteLength / MB) / (clone / 1000)
            })
          }
        } finally {
          await pool.destroy()
        }
        report.note('Payloads are sent without transfer (`src/compute.js:286`) because the caller reuses the buffer for syncStep2, so the main thread pays the clone on every offloaded merge and state-vector computation. What the clone costs the *main thread* is the `clone (ms)` column; `pool round-trip` is the wall-clock the caller waits, which is close to `local scan` because the work itself dominates — the offload buys event-loop availability, not latency.')
      }
    },
    {
      id: 'Y1.7',
      name: 'Y1.1 and Y1.4 with USE_Y_NATIVE=1',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        if (!config.run.useYNative) {
          report.note('**Not run.** Everything else in this report measures the `@y/y` merge path, which is what yhub runs by default. Set `run.useYNative: true` in `src/config.js` to additionally re-run Y1.1 and Y1.4 in a process with `USE_Y_NATIVE=1`, which routes merging through the native yrs (Rust) binding (`@y-crdt/yn`, `src/y-utils.js:29`). That path exists specifically to be benchmarked against this hot loop and nothing else in the repo exercises it — if it is substantially faster it changes the scaling advice, since merging is the expensive primitive behind both sync and compaction.')
          return
        }
        const native = await runNative()
        native.y11.forEach(/** @param {any} r */ r => report.row({ bench: 'Y1.1', ...r }))
        native.y14.forEach(/** @param {any} r */ r => report.row({ bench: 'Y1.4', ...r }))
        report.note('The native yrs merge path (`@y-crdt/yn`, enabled by `USE_Y_NATIVE=1`) exists specifically to benchmark this hot path and nothing else exercises it. Compare against Y1.1 and Y1.4 above; a large gap changes the scaling advice.')
      }
    }
  ]
}
