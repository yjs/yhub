// REST-only equivalent of `yhub.agentTask`.
//
// This is a runnable documentation example, not part of the package surface.
// Use this shape when your agent runs in a different process than y/hub and
// can only talk to it over HTTP — e.g. a long-running LLM worker calling into a
// shared yhub deployment.
//
// Differences from the in-process `yhub.agentTask` (src/agents.js):
// - Drives the workflow entirely through `GET /ydoc?awareness=true` and
//   `PATCH /ydoc` (no Redis / stream access).
// - No `author` / `promptBy` / `displayedAuthor` — those become responsibilities
//   of the caller. The handler can call `awareness.setLocalState(...)` to seed
//   any presence state it wants (and the live-PATCH loop ships it).
//   Attribution-side per-edit author tagging is intentionally dropped here
//   since the REST endpoint already attributes to the authenticated userid.
// - `customAttributions` is preserved: each ydoc edit is PATCHed with the same
//   `customAttributions` array, identical to the WS/REST shape.
//
// Live model: every `ydoc.on('update', …)` and `awareness.on('update', …)` fires
// an independent PATCH. Redis sequencing on the yhub side orders them for
// downstream clients, the same way the in-process version relies on it.

import * as Y from '@y/y'
import * as awarenessProtocol from '@y/protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

const encodeBody = body => {
  const enc = encoding.createEncoder()
  encoding.writeAny(enc, body)
  return encoding.toUint8Array(enc)
}

const decodeBody = bin => decoding.readAny(decoding.createDecoder(new Uint8Array(bin)))

/**
 * GET helper. Returns the lib0-any-decoded response body.
 *
 * @param {string} url
 * @param {RequestInit} [init] additional fetch options (e.g. credentials, headers)
 */
const restGet = async (url, init = {}) => {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return decodeBody(await res.arrayBuffer())
}

/**
 * PATCH helper. Encodes `body` as lib0-any and decodes the response.
 *
 * @param {string} url
 * @param {any} body
 * @param {RequestInit} [init]
 */
const restPatch = async (url, body, init = {}) => {
  const res = await fetch(url, {
    ...init,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/octet-stream', ...(init.headers || {}) },
    body: encodeBody(body)
  })
  if (!res.ok) throw new Error(`PATCH ${url} -> ${res.status}`)
  return decodeBody(await res.arrayBuffer())
}

/**
 * Run an LLM agent task against a yhub room via REST. The handler receives a
 * `Y.Doc` (snapshot of the room's current gc'd state) and an `Awareness`
 * instance; edits to either are PATCHed live to the server, which distributes
 * them to all connected clients through the usual Redis channel.
 *
 * Attribution of the inserts/deletes is performed server-side against the
 * authenticated user (whatever `auth-cookie` your fetch is sending). Pass
 * `customAttributions` to additionally tag every edit with `insert:${k}` /
 * `delete:${k}` attribution attributes.
 *
 * @template R
 * @param {string} baseUrl  e.g. 'http://localhost:3002'
 * @param {{ org: string, docid: string, branch?: string }} room
 * @param {{
 *   customAttributions?: Array<{ k: string, v: string }>,
 *   clearAwareness?: number | false,
 *   fetchInit?: RequestInit
 * }} [opts]
 * @param {(ydoc: Y.Doc, awareness: awarenessProtocol.Awareness) => Promise<R> | R} handler
 * @returns {Promise<R>}
 */
export const restAgentTask = async (
  baseUrl,
  { org, docid, branch = 'main' },
  { customAttributions = [], clearAwareness = 0, fetchInit = {} } = {},
  handler
) => {
  const docUrl = `${baseUrl}/ydoc/${encodeURIComponent(org)}/${encodeURIComponent(docid)}?branch=${encodeURIComponent(branch)}`

  // Fetch the current state (gc'd) and any existing awareness in one go.
  const initial = await restGet(`${docUrl}&awareness=true`, fetchInit)
  const ydoc = new Y.Doc()
  // Apply the snapshot BEFORE attaching the live listener — otherwise the
  // entire document would be re-PATCHed as the agent's own change.
  if (initial.doc instanceof Uint8Array && initial.doc.byteLength > 0) {
    Y.applyUpdate(ydoc, initial.doc)
  }
  const awareness = new awarenessProtocol.Awareness(ydoc)
  // Hydrate existing presence so the handler can observe other clients.
  if (initial.awareness instanceof Uint8Array) {
    awarenessProtocol.applyAwarenessUpdate(awareness, initial.awareness, 'rest-init')
  }

  /** @type {Error | null} */
  let pendingError = null
  /**
   * @param {any} err
   * @param {string} ctx
   */
  const captureErr = (err, ctx) => {
    console.error(`[restAgentTask] ${ctx}:`, err)
    if (pendingError == null) pendingError = err
  }

  /**
   * @param {Uint8Array} update
   */
  const onUpdate = update => {
    if (update.byteLength <= 3) return
    restPatch(docUrl, { update, customAttributions }, fetchInit)
      .catch(err => captureErr(err, 'failed to PATCH ydoc update'))
  }
  /**
   * @param {{ added: number[], updated: number[], removed: number[] }} changes
   */
  const onAwareness = ({ added, updated, removed }) => {
    const clients = added.concat(updated, removed)
    if (clients.length === 0) return
    const bytes = awarenessProtocol.encodeAwarenessUpdate(awareness, clients)
    restPatch(docUrl, { awareness: bytes }, fetchInit)
      .catch(err => captureErr(err, 'failed to PATCH awareness'))
  }

  ydoc.on('update', onUpdate)
  awareness.on('update', onAwareness)

  /** @type {R | undefined} */
  let result
  try {
    result = await handler(ydoc, awareness)
  } catch (err) {
    captureErr(err, 'agent handler threw')
  }
  ydoc.off('update', onUpdate)
  awareness.off('update', onAwareness)

  // On success with clearAwareness=false, skip the disconnect.
  // On error, clear immediately regardless of the configured delay.
  const skipClear = pendingError == null && clearAwareness === false
  if (!skipClear) {
    const delayMs = pendingError != null ? 0 : /** @type {number} */ (clearAwareness) * 1000
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
    // Encode an awareness disconnect for this agent's clientID. Bare-bytes
    // format, exactly what the PATCH endpoint's `awareness` field expects —
    // mirrors src/protocol.js#encodeAwarenessUserDisconnected.
    const meta = awareness.meta.get(awareness.clientID)
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1) // one change
    encoding.writeVarUint(enc, awareness.clientID)
    encoding.writeVarUint(enc, (meta?.clock ?? 0) + 1)
    encoding.writeVarString(enc, JSON.stringify(null))
    try {
      await restPatch(docUrl, { awareness: encoding.toUint8Array(enc) }, fetchInit)
    } catch (err) {
      captureErr(err, 'failed to clear agent awareness')
    }
  }

  awareness.destroy()
  ydoc.destroy()

  if (pendingError != null) throw pendingError
  return /** @type {R} */ (result)
}

// ---- Example usage ----------------------------------------------------------
//
// const { delta } = await import('lib0/delta')
//
// await restAgentTask(
//   'http://localhost:3002',
//   { org: 'my-org', docid: 'my-doc', branch: 'main' },
//   {
//     customAttributions: [
//       { k: 'source', v: 'agent-v1' },
//       { k: 'model', v: 'opus-4.7' }
//     ],
//     clearAwareness: 10,
//     fetchInit: { headers: { cookie: 'auth-cookie=…' } }
//   },
//   async (ydoc, awareness) => {
//     awareness.setLocalState({ user: { name: 'Claude' } })
//     ydoc.get().applyDelta(delta.create().insert('Hello from a REST-only agent').done())
//   }
// )
