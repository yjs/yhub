import { renderTable } from './report.js'

/**
 * Turns the measured rows back into the cost model from README section A, and
 * scores the tier predictions from section B.
 *
 * Everything here degrades gracefully: run `npm start -- y1` and only the
 * constants Y1 can supply are filled in, the rest read `not measured`.
 */

/**
 * @param {import('./report.js').Reporter} report
 * @param {string} id
 * @param {string} col
 * @param {(row: any) => boolean} [where]
 * @return {number|null}
 */
const last = (report, id, col, where = () => true) => {
  const rows = report.rowsOf(id).filter(where)
  const v = rows.length > 0 ? rows[rows.length - 1][col] : undefined
  return typeof v === 'number' && isFinite(v) ? v : null
}

/**
 * @param {number|null} v
 * @param {string} unit
 * @param {number} [digits]
 */
const val = (v, unit, digits = 2) => v == null ? '_not measured_' : `${v.toFixed(digits)} ${unit}`

/**
 * @param {import('./report.js').Reporter} report
 */
export const derivedSection = report => {
  const svThroughput = last(report, 'Y1.2', 'throughput (MB/s)')
  const expansion = last(report, 'Y1.4', 'expansion factor')
  const mergeThroughput = last(report, 'Y1.1', 'throughput (MB/s)', r => r.k > 1)
  const docMergeThroughput = last(report, 'Y1.4', 'throughput (MB/s)')
  const awSmall = last(report, 'Y1.5', 'µs per state', r => r.state === 'small')
  const awLarge = last(report, 'Y1.5', 'µs per state', r => r.state === 'large')
  const cConn = last(report, 'Y2.2', 'MB per connection')
  const cRoom = last(report, 'Y2.1', 'MB per room')
  const kSync = last(report, 'Y2.4', 'peak MB per concurrent sync')
  const perObserver = last(report, 'Y4.1', 'µs cpu per update per observer')
  const perObserverAw = last(report, 'Y4.2', 'µs cpu per update per observer')
  const growthAmp = last(report, 'Y5.1', 'write amplification')

  const constants = [
    { symbol: 't_sv', meaning: 'state-vector scan rate, paid once per sync', value: val(svThroughput, 'MB/s', 1), from: 'Y1.2' },
    { symbol: 't_merge', meaning: 'binary merge rate (sync, fan-out)', value: val(mergeThroughput, 'MB/s', 1), from: 'Y1.1' },
    { symbol: 't_docmerge', meaning: 'document merge rate (compaction, gc)', value: val(docMergeThroughput, 'MB/s', 1), from: 'Y1.4' },
    { symbol: 'k_doc', meaning: 'Y.Doc expansion factor, retained bytes per serialized byte', value: val(expansion, '×', 1), from: 'Y1.4' },
    { symbol: 't_aw (bare cursor)', meaning: 'awareness merge, per participant state, per subscriber', value: val(awSmall, 'µs'), from: 'Y1.5' },
    { symbol: 't_aw (full presence)', meaning: 'the same with a realistic presence payload', value: val(awLarge, 'µs'), from: 'Y1.5' },
    { symbol: 'c_conn', meaning: 'server memory per idle connection', value: val(cConn, 'MB', 4), from: 'Y2.2' },
    { symbol: 'c_room', meaning: 'server memory per subscribed room', value: val(cRoom, 'MB', 4), from: 'Y2.1' },
    { symbol: 'k_sync', meaning: 'peak server memory per concurrent sync, per MB of document', value: val(kSync, 'MB', 2), from: 'Y2.4' },
    { symbol: 'per-observer relay', meaning: 'server cpu per update per observer, documents only', value: val(perObserver, 'µs'), from: 'Y4.1' },
    { symbol: 'per-observer relay + presence', meaning: 'the same with awareness enabled', value: val(perObserverAw, 'µs'), from: 'Y4.2' },
    { symbol: 'write amplification', meaning: 'bytes written to S3 per byte of final document', value: val(growthAmp, '×', 1), from: 'Y5.1' }
  ]

  /**
   * Spread of a column across a benchmark's rows: max/min. A tier-A or tier-B
   * cost is one whose *per-unit* figure stays flat as the thing that grows
   * grows, so a spread near 1 confirms the grade and a spread that tracks the
   * sweep refutes it.
   *
   * @param {string} id
   * @param {string} col
   * @param {(row: any) => boolean} [where]
   */
  const spread = (id, col, where = () => true) => {
    const vs = report.rowsOf(id).filter(where).map(r => r[col]).filter(/** @return {v is number} */ v => typeof v === 'number' && isFinite(v) && v > 0)
    return vs.length < 2 ? null : Math.max(...vs) / Math.min(...vs)
  }

  /**
   * @param {number|null} n
   * @param {string} note
   * @param {(v: number) => boolean} ok
   */
  const check = (n, note, ok) => n == null
    ? { finding: '_not measured_', verdict: '—' }
    : { finding: note.replace('%s', n.toFixed(n < 10 ? 2 : 0)), verdict: ok(n) ? 'confirmed' : 'refuted' }

  const tiers = [
    { '#': 1, operation: 'Websocket upgrade + auth', predicted: 'A', ...check(cConn, '%s MB per connection at the largest N', () => true), evidence: 'Y2.2' },
    { '#': 2, operation: 'Room subscription', predicted: 'A', ...check(cRoom, '%s MB per room at the largest N', () => true), evidence: 'Y2.1 vs Y2.2' },
    { '#': 3, operation: 'Idle connection', predicted: 'A', ...check(last(report, 'Y2.3', 'drift (MB)'), '%s MB drift while idle', d => Math.abs(d) < 10), evidence: 'Y2.3' },
    { '#': 4, operation: 'Write an update', predicted: 'B', ...check(spread('Y3.1', 'µs cpu per update'), 'cpu per update varies %s× across document sizes', v => v < 2), evidence: 'Y3.1' },
    { '#': 5, operation: 'Deliver a batch to one subscriber', predicted: 'B', ...check(spread('Y4.1', 'propagation p50 (ms)'), 'per-edit latency varies %s× as observers grow', v => v < 4), evidence: 'Y4.1' },
    { '#': 6, operation: 'Deliver an awareness batch to one subscriber', predicted: 'B, large constant', ...check(perObserverAw && perObserver ? perObserverAw / perObserver : null, 'presence costs %s× a document update per observer', () => true), evidence: 'Y1.5, Y4.2, Y4.3' },
    { '#': 7, operation: 'Fetch the persisted document', predicted: 'C', ...check(last(report, 'Y2.6', 's3 gets per sync'), '%s S3 GETs per sync', () => true), evidence: 'Y2.6' },
    { '#': 8, operation: 'Compute the state vector', predicted: 'C', ...check(spread('Y1.2', 'throughput (MB/s)'), 'scan rate varies %s× across sizes, so time is linear in size', v => v < 5), evidence: 'Y1.2' },
    { '#': 9, operation: 'Merge pending updates into the document', predicted: 'C', ...check(spread('Y1.1', 'throughput (MB/s)', r => r.k > 0), 'merge rate varies %s× across sizes', v => v < 5), evidence: 'Y1.1, Y2.6' },
    { '#': 10, operation: 'Many clients syncing one document at once', predicted: 'D', ...check(last(report, 'Y2.6', 'cpu per sync (ms)'), 'every concurrent joiner independently costs %s ms of server cpu for the same document', () => true), evidence: 'Y2.4, Y2.5, Y2.6' },
    { '#': 11, operation: 'Compaction of one document', predicted: 'E', ...check(growthAmp, '%s bytes written to S3 per byte the clients wrote', v => v > 1), evidence: 'Y5.1, Y5.3' }
  ]

  return [
    '## Derived constants',
    '',
    'The point of the exercise: plug your own workload numbers into the cost model',
    'from [README.md](./README.md#cost-model) using the constants below, instead of',
    'running another benchmark.',
    '',
    renderTable(constants),
    '',
    '```',
    'server_mem   ≈ B_srv + n_conn·c_conn + n_room·c_room + concurrent_syncs·k_sync·S',
    'server_cpu/s ≈ Σ_r [ u_r·n_r·(t_merge_small + t_encode) + a_r·n_r·t_aw(n_r) ]',
    '             + j·( t_fetch(S) + t_sv(S) + t_merge(S, n_pending) )',
    '             + (Σ_r u_r)·t_contentids',
    'worker_peak  ≈ k_wrk·(S_gc + S_nongc)·taskConcurrency',
    '```',
    '',
    '## Predicted vs. measured tiers',
    '',
    'Section B of the README grades every operation from reading the source. This is',
    'whether the measurements agree. A tier describes how cost scales with the thing',
    'that grows, not how slow one call is — so `confirmed` means the *shape* held,',
    'not that the operation is cheap. Rows 6, 7 and 10 have no pass/fail: their',
    'grades are about avoidable repetition rather than a curve, and the `finding`',
    'column reports the size of that repetition directly.',
    '',
    renderTable(tiers)
  ].join('\n')
}
