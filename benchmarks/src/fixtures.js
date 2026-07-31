import * as fs from 'node:fs'
import * as Y from '@y/y'
import * as prng from 'lib0/prng'
import config from './config.js'

/**
 * Deterministic fixture documents.
 *
 * Shape is a flat map keyed `"row:col"` — the spreadsheet-like workload the cost
 * model was written for. Everything is generated from `config.fixtures.seed`, so
 * two people on two machines benchmark the same bytes. Generated blobs are
 * cached in `benchmarks/fixtures/`; delete that folder to regenerate.
 *
 * Three variants, because they stress compaction very differently (Y5.3):
 * - `fresh`     — written once, no history
 * - `churned`   — every cell rewritten `churnFactor` times, tombstoning the old
 *                 values. A spreadsheet worked on for a week.
 * - `rowChurn`  — rows inserted and then deleted
 *
 * `targetBytes` is the size of the *live content* — the document grown fresh,
 * before any churn is applied. For `fresh` that is also the gc size. For the
 * other two the gc size comes out larger, because a gc document still encodes
 * the delete set; how much larger is exactly what Y5.3 reports. The stored blob
 * is always the **nongc** document (the full history), and `gcUpdate` is derived
 * from it, so both sizes are available from one file.
 */

const fixturesDir = new URL('../fixtures/', import.meta.url)

/**
 * @param {number} bytes
 */
export const sizeLabel = bytes => {
  if (bytes === 0) return 'empty'
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}mb`
  return `${Math.round(bytes / 1024)}kb`
}

/**
 * @param {Uint8Array<ArrayBuffer>} nongcUpdate
 * @return {Uint8Array<ArrayBuffer>}
 */
export const toGcUpdate = nongcUpdate => {
  const doc = new Y.Doc({ gc: true })
  Y.applyUpdate(doc, nongcUpdate)
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

/**
 * Fill `cells` with `count` new entries starting at `startIndex`.
 *
 * @param {Y.Doc} doc
 * @param {any} cells
 * @param {prng.PRNG} gen
 * @param {number} startIndex
 * @param {number} count
 */
const insertCells = (doc, cells, gen, startIndex, count) => {
  const { cellChars, cols } = config.fixtures
  doc.transact(() => {
    for (let i = startIndex; i < startIndex + count; i++) {
      cells.setAttr(`${Math.floor(i / cols)}:${i % cols}`, prng.word(gen, cellChars, cellChars))
    }
  })
}

/**
 * Grow a document until its encoded size reaches `targetBytes`. Re-measures
 * after every batch and extrapolates, rather than encoding per cell, which would
 * be quadratic.
 *
 * @param {number} targetBytes
 * @param {prng.PRNG} gen
 * @return {{ doc: Y.Doc, cells: any, cellCount: number }}
 */
const growTo = (targetBytes, gen) => {
  const doc = new Y.Doc({ gc: false })
  const cells = doc.get('cells')
  let cellCount = 0
  let size = Y.encodeStateAsUpdate(doc).byteLength
  while (size < targetBytes) {
    const bytesPerCell = cellCount > 0 ? size / cellCount : 48
    const batch = Math.max(256, Math.floor((targetBytes - size) / bytesPerCell))
    insertCells(doc, cells, gen, cellCount, batch)
    cellCount += batch
    size = Y.encodeStateAsUpdate(doc).byteLength
  }
  return { doc, cells, cellCount }
}

/**
 * @param {'fresh'|'churned'|'rowChurn'} variant
 * @param {number} targetBytes
 * @return {Uint8Array<ArrayBuffer>}
 */
const generate = (variant, targetBytes) => {
  const gen = prng.create(config.fixtures.seed)
  const { doc, cells, cellCount } = growTo(targetBytes, gen)
  const { cellChars, cols, churnFactor, rowChurnRatio } = config.fixtures
  if (variant === 'churned') {
    // rewrite every cell `churnFactor` times: the gc document keeps its size,
    // the nongc document accumulates every superseded value
    for (let round = 0; round < churnFactor; round++) {
      doc.transact(() => {
        for (let i = 0; i < cellCount; i++) {
          cells.setAttr(`${Math.floor(i / cols)}:${i % cols}`, prng.word(gen, cellChars, cellChars))
        }
      })
    }
  } else if (variant === 'rowChurn') {
    // append rows and delete them again, leaving only the delete set behind
    const extra = Math.floor(cellCount * rowChurnRatio)
    insertCells(doc, cells, gen, cellCount, extra)
    doc.transact(() => {
      for (let i = cellCount; i < cellCount + extra; i++) {
        cells.deleteAttr(`${Math.floor(i / cols)}:${i % cols}`)
      }
    })
  }
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

/**
 * @typedef {{ update: Uint8Array<ArrayBuffer>, gcUpdate: Uint8Array<ArrayBuffer>, gcBytes: number, nongcBytes: number, cells: number, variant: string, targetBytes: number }} Fixture
 */

/** @type {Map<string, Fixture>} */
const memo = new Map()

/**
 * @param {object} opts
 * @param {'fresh'|'churned'|'rowChurn'} [opts.variant]
 * @param {number} opts.targetBytes
 * @return {Fixture}
 */
export const getFixture = ({ variant = 'fresh', targetBytes }) => {
  const key = `${variant}-${sizeLabel(targetBytes)}-s${config.fixtures.seed}`
  const cached = memo.get(key)
  if (cached != null) return cached
  const file = new URL(`${key}.ydoc`, fixturesDir)
  /** @type {Uint8Array<ArrayBuffer>} */
  let update
  if (fs.existsSync(file)) {
    update = new Uint8Array(fs.readFileSync(file))
  } else {
    console.log(`  generating fixture ${key} …`)
    update = targetBytes === 0 ? Y.encodeStateAsUpdate(new Y.Doc()) : generate(variant, targetBytes)
    fs.mkdirSync(fixturesDir, { recursive: true })
    fs.writeFileSync(file, update)
  }
  const gcUpdate = variant === 'fresh' ? update : toGcUpdate(update)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, update)
  const cells = doc.get('cells').attrSize
  doc.destroy()
  const fixture = { update, gcUpdate, gcBytes: gcUpdate.byteLength, nongcBytes: update.byteLength, cells, variant, targetBytes }
  memo.set(key, fixture)
  return fixture
}

/**
 * `count` independent small updates, as a client's individual cell edits would
 * arrive. Each one is a diff against the previous state, so merging all of them
 * is the work the server does on sync.
 *
 * @param {number} count
 * @param {object} [opts]
 * @param {number} [opts.seed]
 * @param {number} [opts.cellsPerUpdate]
 * @return {Array<Uint8Array<ArrayBuffer>>}
 */
export const makeCellUpdates = (count, { seed = config.fixtures.seed + 1, cellsPerUpdate = 1 } = {}) => {
  const gen = prng.create(seed)
  const doc = new Y.Doc()
  const cells = doc.get('cells')
  const { cellChars, cols } = config.fixtures
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const updates = []
  let sv = Y.encodeStateVector(doc)
  for (let i = 0; i < count; i++) {
    doc.transact(() => {
      for (let j = 0; j < cellsPerUpdate; j++) {
        const n = i * cellsPerUpdate + j
        cells.setAttr(`e${Math.floor(n / cols)}:${n % cols}`, prng.word(gen, cellChars, cellChars))
      }
    })
    updates.push(Y.encodeStateAsUpdate(doc, sv))
    sv = Y.encodeStateVector(doc)
  }
  doc.destroy()
  return updates
}

/**
 * A one-cell update whose value is `nonce`. Yjs encodes string content verbatim,
 * so an observer can find the nonce in an arriving frame with a byte search and
 * time its propagation without decoding anything — and the nonce survives the
 * server's per-subscriber re-merge.
 *
 * @param {string} nonce
 * @return {Uint8Array<ArrayBuffer>}
 */
export const makeNonceUpdate = nonce => {
  const doc = new Y.Doc()
  doc.get('cells').setAttr('nonce', nonce)
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

/**
 * One update containing `cellCount` edits — an agent flushing a batch (Y3.2).
 *
 * @param {number} cellCount
 * @param {number} [seed]
 * @return {Uint8Array<ArrayBuffer>}
 */
export const makeBatchUpdate = (cellCount, seed = config.fixtures.seed + 2) =>
  makeCellUpdates(1, { seed, cellsPerUpdate: cellCount })[0]

/**
 * Every fixture the configured sweeps need: `fresh` at every size that gets
 * synced or merged, and all three variants at the scenario size, which is what
 * Y5.3 compacts. Run with `npm run fixtures` to pre-generate so that a timed run
 * never pays generation cost.
 */
export const usedFixtures = () => {
  const sizes = [...new Set([...config.scale.docSizes, ...config.scale.primitiveDocSizes])].filter(s => s > 0)
  /** @type {Array<{variant: 'fresh'|'churned'|'rowChurn', targetBytes: number}>} */
  const wanted = sizes.map(targetBytes => ({ variant: /** @type {'fresh'} */ ('fresh'), targetBytes }))
  for (const variant of /** @type {Array<'churned'|'rowChurn'>} */ (['churned', 'rowChurn'])) {
    wanted.push({ variant, targetBytes: config.fixtures.churnTarget })
  }
  return wanted
}

export const generateAll = () => usedFixtures().map(({ variant, targetBytes }) => {
  const f = getFixture({ variant, targetBytes })
  return {
    variant,
    target: sizeLabel(targetBytes),
    cells: f.cells,
    'gc (MB)': f.gcBytes / 1024 / 1024,
    'nongc (MB)': f.nongcBytes / 1024 / 1024,
    'cells/MB': f.cells / (f.gcBytes / 1024 / 1024)
  }
})

if (import.meta.url === `file://${process.argv[1]}`) {
  console.table(generateAll())
}
