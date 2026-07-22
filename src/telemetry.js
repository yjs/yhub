/**
 * Utilities for measuring spans of work as a streamable record of span-updates.
 *
 * Data-first: a {@link Record} is an append-only list of JSON-encodable span-updates —
 * the wire format. Spans are lightweight handles that append `start_span` /
 * `update_span` / `end_span` entries; consecutive attribute writes coalesce into the
 * last update. A process can drain the record and write the updates anywhere (redis,
 * a file, a socket) and reassemble trees with {@link buildTree}.
 *
 * Times are nanoseconds: `Record.origin` is an epoch-ns anchor and every update `time`
 * is an exact integer offset-ns relative to it (offsets stay below 2^53 for ~104 days;
 * epoch-ns itself does not fit exactly in a double). Absolute time = origin + time.
 *
 * @module telemetry
 */

import * as perf from 'lib0/performance'
import * as prom from 'lib0/promise'
import * as math from 'lib0/math'
import * as random from 'lib0/random'

/**
 * Hidden monotonic anchor — Symbol-keyed properties are skipped by JSON.stringify and
 * structuredClone, keeping records/updates serializable.
 */
const t0 = Symbol('t0')

/**
 * @typedef {{ type: 'start_span', id: string, parent: string?, name: string, time: number }} StartSpan
 */

/**
 * @typedef {{ type: 'update_span', id: string, attrs: Array<[string, any]> }} UpdateSpan
 */

/**
 * `success:false, err:false` is reserved for future cancellation semantics; a thrown
 * error additionally lands as an `error` attribute ({ name, message, stack }).
 *
 * @typedef {{ type: 'end_span', id: string, time: number, success: boolean, err: boolean }} EndSpan
 */

/**
 * @typedef {StartSpan | UpdateSpan | EndSpan} SpanUpdate
 */

/**
 * JSON-safe representation of a thrown value.
 *
 * @param {any} err
 * @returns {{ name: string, message: string, stack?: string }}
 */
export const exception = err => ({ name: err?.name ?? 'Error', message: err?.message ?? String(err), stack: err?.stack })

/**
 * Span ids are unique across threads and processes: a random per-thread prefix plus a
 * counter (a uuid per span would dominate the cost of measuring).
 */
const idPrefix = random.uint32().toString(36) + random.uint32().toString(36) + '-'
let idCounter = 0

export class Record {
  /**
   * @param {boolean} discard
   * @param {((updates: Array<SpanUpdate>) => void)?} onFlush
   */
  constructor (discard, onFlush) {
    /**
     * Epoch-ns anchor (ms-granular — derived from Date.now once). Absolute time of an
     * update is `origin + update.time`.
     */
    this.origin = Date.now() * 1e6
    /**
     * @type {Array<SpanUpdate>}
     */
    this.updates = []
    /**
     * When true, appends are dropped — measuring stays cheap and memory bounded
     * without a consumer.
     */
    this.discard = discard
    /**
     * @type {((updates: Array<SpanUpdate>) => void)?}
     */
    this.onFlush = onFlush
    this._flushScheduled = false
    this[t0] = perf.now()
  }

  /**
   * Exact integer nanoseconds since the record was created (monotonic).
   */
  now () {
    return math.round((perf.now() - this[t0]) * 1e6)
  }

  /**
   * @param {SpanUpdate} update
   */
  add (update) {
    if (this.discard) return
    this.updates.push(update)
    if (this.onFlush !== null && !this._flushScheduled) {
      this._flushScheduled = true
      setTimeout(() => {
        this._flushScheduled = false
        const updates = this.drain()
        updates.length > 0 && this.onFlush?.(updates)
      }, 0)
    }
  }

  /**
   * Take all updates appended since the last drain.
   */
  drain () {
    return this.updates.splice(0)
  }

  /**
   * Create a span on this record. Without `fn`, returns the open {@link Span} — end it
   * manually. With `fn`, runs `fn(span)` and returns its result: the span auto-ends, a
   * synchronous throw is recorded and rethrown, and a returned thenable ends the span on
   * settle (rejections propagate through the returned promise).
   *
   * `parent` links the span to a parent — a {@link Span} handle, or a span id string
   * for parents living in another thread/process.
   *
   * @overload
   * @param {string} name
   * @param {undefined} [fn]
   * @param {Span | string | null} [parent]
   * @returns {Span}
   */
  /**
   * @template T
   * @overload
   * @param {string} name
   * @param {(span: Span) => T} fn
   * @param {Span | string | null} [parent]
   * @returns {T}
   */
  /**
   * @param {string} name
   * @param {(span: Span) => any} [fn]
   * @param {Span | string | null} [parent]
   * @returns {any}
   */
  span (name, fn, parent = null) {
    const s = new Span(this, name, parent)
    if (fn === undefined) return s
    try {
      const res = fn(s)
      if (prom.isPromise(res)) {
        return res.then((/** @type {any} */ r) => { s.end(); return r }, (/** @type {any} */ err) => { s.end(err); throw err })
      }
      s.end()
      return res
    } catch (err) {
      s.end(err)
      throw err
    }
  }
}

/**
 * A lightweight handle over the record — the span data itself lives in the record's
 * updates.
 */
export class Span {
  /**
   * @param {Record} record
   * @param {string} name
   * @param {Span | string | null} parent
   */
  constructor (record, name, parent) {
    this.record = record
    this.name = name
    this.id = idPrefix + (++idCounter).toString(36)
    /**
     * @type {Span?}
     */
    this.parent = typeof parent === 'string' ? null : parent
    /**
     * Integer offset-ns of the span start (relative to `record.origin`).
     */
    this.startTime = record.now()
    record.add({ type: 'start_span', id: this.id, parent: typeof parent === 'string' ? parent : (parent?.id ?? null), name, time: this.startTime })
  }

  /**
   * Create a child span (see {@link Record.span}).
   *
   * @overload
   * @param {string} name
   * @param {undefined} [fn]
   * @returns {Span}
   */
  /**
   * @template T
   * @overload
   * @param {string} name
   * @param {(span: Span) => T} fn
   * @returns {T}
   */
  /**
   * @param {string} name
   * @param {(span: Span) => any} [fn]
   * @returns {any}
   */
  span (name, fn) {
    return fn === undefined ? this.record.span(name, undefined, this) : this.record.span(name, fn, this)
  }

  /**
   * Set an attribute — coalesces into the record's last update when it is an
   * update_span of this span. Values should be JSON-encodable; function values are
   * tolerated for same-process lazy debug capture (JSON and pino drop them) but must
   * never cross worker_threads. Set attributes before `end`.
   *
   * @param {string} name
   * @param {any} value
   */
  attr (name, value) {
    const updates = this.record.updates
    const last = updates.length > 0 ? updates[updates.length - 1] : null
    if (last !== null && last.type === 'update_span' && last.id === this.id) {
      last.attrs.push([name, value])
    } else {
      this.record.add({ type: 'update_span', id: this.id, attrs: [[name, value]] })
    }
    return this
  }

  /**
   * Integer nanoseconds since this span started.
   */
  elapsed () {
    return this.record.now() - this.startTime
  }

  /**
   * End the span. A given `err` is recorded as an `error` attribute and flags the end
   * entry. Call once.
   *
   * @param {any} [err]
   */
  end (err) {
    err == null || this.attr('error', exception(err))
    this.record.add({ type: 'end_span', id: this.id, time: this.record.now(), success: err == null, err: err != null })
    return this
  }
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.discard] drop all updates — measuring without a consumer stays memory-bounded
 * @param {((updates: Array<SpanUpdate>) => void)?} [opts.onFlush] debounced push consumer — receives everything appended since the last flush/drain
 */
export const createRecord = ({ discard = false, onFlush = null } = {}) => new Record(discard, onFlush)

/**
 * @typedef {{ id: string, parent: string?, name: string, time: number, duration: number, success: boolean, err: boolean, attributes: Object<string, any>, children: Array<SpanNode> }} SpanNode
 */

/**
 * Fold span-updates into trees. Returns the roots — spans without a parent, or whose
 * parent's start is not part of `updates`. Unended spans have `duration: -1`.
 *
 * @param {Array<SpanUpdate>} updates
 * @returns {Array<SpanNode>}
 */
export const buildTree = updates => {
  /**
   * @type {Map<string, SpanNode>}
   */
  const nodes = new Map()
  /**
   * @type {Array<SpanNode>}
   */
  const roots = []
  updates.forEach(u => {
    switch (u.type) {
      case 'start_span': {
        /** @type {SpanNode} */
        const node = { id: u.id, parent: u.parent, name: u.name, time: u.time, duration: -1, success: true, err: false, attributes: {}, children: [] }
        nodes.set(u.id, node)
        const parent = u.parent === null ? undefined : nodes.get(u.parent)
        parent !== undefined ? parent.children.push(node) : roots.push(node)
        break
      }
      case 'update_span': {
        const node = nodes.get(u.id)
        node !== undefined && u.attrs.forEach(([name, value]) => { node.attributes[name] = value })
        break
      }
      case 'end_span': {
        const node = nodes.get(u.id)
        if (node !== undefined) {
          node.duration = u.time - node.time
          node.success = u.success
          node.err = u.err
        }
        break
      }
    }
  })
  return roots
}
