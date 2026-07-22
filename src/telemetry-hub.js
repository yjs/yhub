import { trace, metrics, SpanStatusCode, ROOT_CONTEXT } from '@opentelemetry/api'
import { createRecord } from './telemetry.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'telemetry' })

export class TelemetryHub {
  /**
   * @param {Exclude<import('./types.js').YHubConfig['telemetry'], null | undefined>} conf
   */
  constructor (conf) {
    this.tracer = (conf.tracerProvider ?? trace.getTracerProvider()).getTracer('@y/hub')
    this._meterProvider = conf.meterProvider ?? null
    /**
     * @type {import('@opentelemetry/api').MeterProvider?}
     */
    this._boundMeterProvider = null
    /**
     * @type {import('@opentelemetry/api').Histogram}
     */
    this._duration = /** @type {any} */ (null)
    this.onUpdate = conf.onUpdate ?? null
    this.log = conf.log ?? 'info'
    /**
     * Open spans by id — carries the eagerly-created OTel span and the accumulated
     * attributes for the wide-event log line emitted at end_span.
     *
     * @type {Map<string, { otspan: import('@opentelemetry/api').Span, name: string, parent: string?, time: number, attributes: Object<string, any> }>}
     */
    this.open = new Map()
    /**
     * The process record all yhub spans append to. Flushes are debounced; each batch is
     * forwarded to `onUpdate` and folded into OTel spans + pino lines.
     */
    this.record = createRecord({ onFlush: updates => this._process(updates) })
  }

  /**
   * The duration histogram, rebound when the global MeterProvider changes: unlike traces
   * (ProxyTracerProvider), the metrics API has no lazy proxy, so a histogram created
   * before the SDK registers would silently stay a no-op forever.
   */
  duration () {
    const mp = this._meterProvider ?? metrics.getMeterProvider()
    if (mp !== this._boundMeterProvider) {
      this._boundMeterProvider = mp
      this._duration = mp.getMeter('@y/hub').createHistogram('yhub.op.duration', { unit: 'ms', description: 'Duration of yhub operations' })
    }
    return this._duration
  }

  /**
   * @param {Array<import('./telemetry.js').SpanUpdate>} updates
   */
  _process (updates) {
    const onUpdate = this.onUpdate
    if (onUpdate !== null) {
      try {
        onUpdate(updates)
      } catch (e) {
        log.warn({ err: e }, 'telemetry onUpdate consumer threw')
      }
    }
    updates.forEach(u => {
      switch (u.type) {
        case 'start_span': {
          const parent = u.parent === null ? undefined : this.open.get(u.parent)
          const otspan = this.tracer.startSpan(u.name, { startTime: (this.record.origin + u.time) / 1e6 }, parent === undefined ? ROOT_CONTEXT : trace.setSpan(ROOT_CONTEXT, parent.otspan))
          this.open.set(u.id, { otspan, name: u.name, parent: u.parent, time: u.time, attributes: {} })
          break
        }
        case 'update_span': {
          const o = this.open.get(u.id)
          o !== undefined && u.attrs.forEach(([name, value]) => {
            o.attributes[name] = value
            const tv = typeof value
            ;(tv === 'string' || tv === 'number' || tv === 'boolean') && o.otspan.setAttribute('yhub.' + name, value)
          })
          break
        }
        case 'end_span': {
          const o = this.open.get(u.id)
          if (o === undefined) break
          this.open.delete(u.id)
          const otspan = o.otspan
          const attrs = o.attributes
          const room = attrs.room
          room != null && typeof room === 'object' && otspan.setAttribute('yhub.room', `${room.org}/${room.docid}/${room.branch}`)
          const error = u.err ? attrs.error ?? { name: 'Error', message: 'unknown error' } : null
          const endTime = (this.record.origin + u.time) / 1e6
          if (error !== null) {
            otspan.recordException(error, endTime)
            otspan.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
          }
          otspan.end(endTime)
          const durationMs = (u.time - o.time) / 1e6
          // low-cardinality metric attributes only — never room/doc ids; op-level spans
          // only ('yhub.'-prefixed by convention), bare-named worker phases stay out;
          // recording in the span's context links histogram outliers to their trace
          if (o.name.startsWith('yhub.')) {
            /**
             * @type {import('@opentelemetry/api').Attributes}
             */
            const mattrs = { 'yhub.op': o.name }
            attrs.task !== undefined && (mattrs['yhub.task'] = attrs.task)
            error !== null && (mattrs['error.type'] = error.name)
            this.duration().record(durationMs, mattrs, trace.setSpan(ROOT_CONTEXT, otspan))
          }
          if (this.log !== false) {
            const { traceId, spanId } = otspan.spanContext()
            /**
             * @type {Object<string, any>}
             */
            const fields = { id: u.id, parent: o.parent ?? undefined, traceId, spanId, durationMs }
            for (const name in attrs) {
              name !== 'error' && typeof attrs[name] !== 'function' && (fields[name] = attrs[name])
            }
            u.err ? log.error({ err: error, ...fields }, o.name) : log[this.log](fields, o.name)
          }
          break
        }
      }
    })
  }
}

/**
 * @param {import('./types.js').YHubConfig['telemetry']} conf
 * @returns {TelemetryHub?}
 */
export const createTelemetry = conf => conf == null ? null : new TelemetryHub(conf)
