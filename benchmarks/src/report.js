import * as fs from 'node:fs'
import * as os from 'node:os'
import { execFileSync } from 'node:child_process'

/**
 * Collects benchmark rows, prints them as they arrive, and renders RESULTS.md.
 *
 * A row is a flat object of column name -> number|string. Columns carry their
 * unit in the name (`time (ms)`, `serverMem (MB)`), so no formatting metadata
 * has to travel with the value and the rendered table documents itself.
 *
 * @typedef {{[key: string]: number|string}} Row
 */

/**
 * Percentiles over a sample array. Reported instead of means because the tail
 * is the failure being looked for (see README, "Percentiles, not means").
 *
 * @param {Array<number>} samples
 */
export const stats = samples => {
  if (samples.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0, n: 0 }
  const sorted = samples.slice().sort((a, b) => a - b)
  const at = /** @param {number} q */ q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    n: sorted.length
  }
}

/**
 * @param {Array<number>} samples
 */
export const median = samples => stats(samples).p50

/**
 * @param {number} n
 */
export const fmtNumber = n => {
  if (!isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs === 0) return '0'
  if (Number.isInteger(n) && abs < 1e6) return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  if (abs >= 1000) return n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  if (abs >= 10) return n.toFixed(1)
  if (abs >= 0.1) return n.toFixed(2)
  return n.toPrecision(2)
}

/**
 * @param {number|string} v
 */
const fmtCell = v => typeof v === 'number' ? fmtNumber(v) : v

/**
 * @param {Array<Row>} rows
 * @return {Array<string>}
 */
const columnsOf = rows => {
  /** @type {Array<string>} */
  const cols = []
  rows.forEach(r => Object.keys(r).forEach(k => cols.includes(k) || cols.push(k)))
  return cols
}

/**
 * @param {Array<Row>} rows
 */
export const renderTable = rows => {
  if (rows.length === 0) return '_no data_'
  const cols = columnsOf(rows)
  const cells = rows.map(r => cols.map(c => r[c] === undefined ? '' : fmtCell(r[c])))
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map(row => row[i].length)))
  const line = /** @param {Array<string>} vs */ vs => '| ' + vs.map((v, i) => v.padStart(widths[i])).join(' | ') + ' |'
  return [
    line(cols),
    '|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|',
    ...cells.map(line)
  ].join('\n')
}

/**
 * Free space on the filesystem backing the storage containers, in GiB.
 *
 * Worth reporting because a full S3 backend does not slow compaction down, it
 * makes it *fail* — the worker retries forever, documents never drain, and every
 * Y5/Y6 number silently becomes meaningless. See the preflight check in
 * `index.js`.
 */
export const freeDiskGiB = () => {
  try { return fs.statfsSync(process.cwd()).bavail * fs.statfsSync(process.cwd()).bsize / 1024 ** 3 } catch (_) { return null }
}

export const machineInfo = () => {
  /** @param {string} cmd @param {Array<string>} args */
  const tryExec = (cmd, args) => {
    try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch (_) { return 'unknown' }
  }
  const cpus = os.cpus()
  return {
    date: new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC',
    freeDisk: freeDiskGiB() == null ? 'unknown' : `${/** @type {number} */ (freeDiskGiB()).toFixed(1)} GiB free`,
    commit: tryExec('git', ['rev-parse', '--short', 'HEAD']),
    yhub: /** @type {{version: string}} */ (JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))).version,
    node: process.version,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: `${cpus[0]?.model?.trim() ?? 'unknown'} (${cpus.length} threads)`,
    memory: `${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB`
  }
}

export class Reporter {
  /**
   * @param {typeof import('./config.js').config} config
   */
  constructor (config) {
    this.config = config
    /**
     * Insertion-ordered benchmark results.
     * @type {Array<{ suite: string, suiteTitle: string, id: string, name: string, note: string|null, warning: string|null, rows: Array<Row> }>}
     */
    this.results = []
    /** @type {{ suite: string, suiteTitle: string, id: string, name: string, note: string|null, warning: string|null, rows: Array<Row> }|null} */
    this.current = null
    this.machine = machineInfo()
  }

  /**
   * @param {{ suite: string, suiteTitle: string, id: string, name: string }} bench
   */
  begin (bench) {
    /** @type {{ suite: string, suiteTitle: string, id: string, name: string, note: string|null, warning: string|null, rows: Array<Row> }} */
    const entry = { ...bench, note: null, warning: null, rows: [] }
    this.current = entry
    this.results.push(entry)
    console.log(`\n\x1b[1m${bench.id}\x1b[0m ${bench.name}`)
    let open = true
    // A benchmark that times out is abandoned but keeps running, and would
    // otherwise append its rows to whichever benchmark is current when it
    // finally resolves. Binding row/note to this entry and closing it on
    // completion keeps a late row out of the next benchmark's table.
    return {
      /** @param {Row} row */
      row: row => {
        if (!open) { console.log(`  \x1b[2m(discarded late row from ${bench.id})\x1b[0m`); return }
        entry.rows.push(row)
        console.log('  ' + Object.entries(row).map(([k, v]) => `${k}=${fmtCell(v)}`).join('  '))
      },
      /** @param {string} text */
      note: text => {
        if (!open) return
        entry.note = text
        console.log(`  \x1b[2m${text}\x1b[0m`)
      },
      /** @param {string} text */
      warn: text => { entry.warning = text },
      close: () => { open = false }
    }
  }

  /**
   * Record and immediately print one row, so a long run stays watchable.
   * @param {Row} row
   */
  row (row) {
    if (this.current == null) throw new Error('report.row() called outside a benchmark')
    this.current.rows.push(row)
    const parts = Object.entries(row).map(([k, v]) => `${k}=${fmtCell(v)}`)
    console.log('  ' + parts.join('  '))
  }

  /**
   * Attach a one-line remark shown under the benchmark's table.
   * @param {string} text
   */
  note (text) {
    if (this.current != null) this.current.note = text
    console.log(`  \x1b[2m${text}\x1b[0m`)
  }

  /**
   * @param {string} id
   */
  rowsOf (id) {
    return this.results.find(r => r.id === id)?.rows ?? []
  }

  /**
   * @param {string} outPath
   * @param {string} derivedSection
   */
  write (outPath, derivedSection) {
    const m = this.machine
    const s = this.config.scale
    /** @type {Array<string>} */
    const out = [
      '# y/hub benchmark results',
      '',
      '_Generated by `cd benchmarks && npm start`. Do not edit by hand._',
      '',
      'What each benchmark measures and why is in [README.md](./README.md).',
      '',
      '## Environment',
      '',
      renderTable([
        { key: 'date', value: m.date },
        { key: 'commit', value: m.commit },
        { key: '@y/hub', value: m.yhub },
        { key: 'node', value: m.node },
        { key: 'platform', value: m.platform },
        { key: 'cpu', value: m.cpu },
        { key: 'memory', value: m.memory },
        { key: 'disk', value: m.freeDisk },
        { key: 'computePoolSize', value: String(this.config.hub.computePoolSize) },
        { key: 'taskDebounce (ms)', value: String(this.config.hub.taskDebounce) },
        { key: 'taskConcurrency', value: String(this.config.hub.taskConcurrency) },
        { key: 'connections swept', value: s.connections.join(', ') },
        { key: 'docSizes swept (MB)', value: s.docSizes.map(b => (b / 1024 / 1024).toFixed(0)).join(', ') },
        { key: 'observers swept', value: s.observers.join(', ') }
      ]),
      '',
      'S3 is MinIO on localhost, so sync and compaction times are **lower bounds** —',
      'real S3 or R2 latency has to be layered onto the `s3Ops` counts analytically.',
      ''
    ]
    let suite = null
    for (const r of this.results) {
      if (r.suite !== suite) {
        suite = r.suite
        out.push(`## ${r.suiteTitle}`, '')
      }
      out.push(`### ${r.id} ${r.name}`, '')
      if (r.warning) out.push(`> ⚠ **${r.warning}**`, '')
      out.push(renderTable(r.rows), '')
      if (r.note) out.push(r.note, '')
    }
    out.push(derivedSection)
    fs.writeFileSync(outPath, out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n')
    console.log(`\n\x1b[1mwrote ${outPath}\x1b[0m (${this.results.length} benchmarks)`)
  }
}
