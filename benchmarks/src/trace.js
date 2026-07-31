import * as fs from 'node:fs'
import * as decoding from 'lib0/decoding'
import config from './config.js'

/**
 * Loader for a supplied editing trace.
 *
 * The format is documented in `TRACE-FORMAT.md`: a single lib0 `writeAny` value
 * holding the document's full history as an ordered list of Yjs v1 updates,
 * each tagged with when it happened, who made it, and whether it inserted or
 * deleted. Update 0 is the server-side import that carries essentially the whole
 * document; the rest are individual human edits.
 *
 * The trace is customer data and is gitignored. Everything here returns `null`
 * when the file is absent, and Y7 skips itself — the rest of the suite is
 * unaffected either way.
 *
 * @typedef {{ update: Uint8Array<ArrayBuffer>, time: number, user: string, kind: string, ranges: number }} TraceStep
 * @typedef {{ type: string, updateFormat: string, gc: boolean, source: any, users: Array<string>, totalBytes: number, updates: Array<TraceStep> }} Trace
 */

const tracePath = new URL(`../${config.trace.file}`, import.meta.url).pathname

export const traceAvailable = () => fs.existsSync(tracePath)

/** @type {Trace|null} */
let memo = null

/**
 * @return {Trace|null}
 */
export const loadTrace = () => {
  if (memo != null) return memo
  if (!traceAvailable()) return null
  const bin = new Uint8Array(fs.readFileSync(tracePath))
  const trace = decoding.readAny(decoding.createDecoder(bin))
  if (trace == null || typeof trace !== 'object' || !Array.isArray(/** @type {any} */ (trace).updates)) {
    throw new Error(`${config.trace.file} is not a recognisable trace — see TRACE-FORMAT.md`)
  }
  memo = /** @type {Trace} */ (trace)
  return memo
}

/**
 * The trace split the way it is meant to be used: update 0 is the baseline
 * document, the remainder are the incremental edits worth timing.
 */
export const splitTrace = () => {
  const trace = loadTrace()
  if (trace == null) return null
  const [baseline, ...edits] = trace.updates
  return { trace, baseline, edits }
}
