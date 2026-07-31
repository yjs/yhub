import { generateAll } from '../fixtures.js'
import { getCluster } from '../cluster.js'
import { verifyHarness } from '../verify.js'

/**
 * The documents every other group is measured against, and a self-check of the
 * harness that measures them.
 */
export default {
  id: 'y0',
  title: 'Y0: Fixtures and harness self-check',
  benchmarks: [
    {
      id: 'Y0.1',
      name: 'Fixture documents',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        generateAll().forEach(row => report.row(row))
        report.note('Reported in cells per MB so a real spreadsheet can be mapped onto these size steps. `fresh` is written once; `churned` rewrites every cell 10×; `rowChurn` inserts and deletes half again as many rows. A gc document still encodes the delete set, which is why the churned variants are larger than their target even after garbage collection.')
      }
    },
    {
      id: 'Y0.2',
      name: 'Harness self-check against real @y/websocket clients',
      /** @param {{ report: import('../report.js').Reporter }} ctx */
      run: async ({ report }) => {
        const cluster = await getCluster()
        const ok = await verifyHarness(cluster, row => report.row(row))
        report.note(ok
          ? 'The load generator is a raw-protocol client that discards payloads — that is what makes many connections affordable, but it also means it cannot notice if what it counted was wrong. These three checks run real `@y/websocket` clients alongside it and confirm edits actually arrive and converge in both directions.'
          : '**The harness self-check failed. Every number below is suspect.**')
      }
    }
  ]
}
