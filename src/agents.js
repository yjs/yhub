import * as Y from '@y/y'
import * as awarenessProtocol from '@y/protocols/awareness'
import * as time from 'lib0/time'
import * as promise from 'lib0/promise'
import * as protocol from './protocol.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'agents' })

/**
 * @typedef {object} AgentTaskOptions
 * @property {number|false} [clearAwareness=0]
 *   Seconds to wait after the handler resolves before broadcasting an awareness
 *   disconnect for this agent. `0` (default) clears immediately on exit.
 *   `false` leaves awareness in place on success; the caller is then responsible
 *   for the agent's awareness lifecycle. Errors always clear immediately.
 * @property {string} [author]
 *   user-id attributed to inserts/deletes via the standard `insert` / `delete`
 *   content attributes. Should normally be a stable user-id, not a display name.
 * @property {string} [displayedAuthor]
 *   Human-readable display name pre-seeded into the agent's awareness state as
 *   `{ user: { name: displayedAuthor } }`, so other connected clients can render
 *   the agent (cursor labels, presence panels). Used only by awareness — never
 *   by attribution. Defaults to `author`. The handler can replace this by
 *   calling `awareness.setLocalState(...)`.
 * @property {string} [promptBy]
 *   Optional custom attribution recording who prompted the agent. Stored as
 *   `insert:promptBy` / `delete:promptBy` via the same customAttributions
 *   convention used by the WS and REST update paths. Equivalent to passing
 *   `customAttributions: [{ k: 'promptBy', v: promptBy }]`; merged with any
 *   explicit `customAttributions`.
 * @property {Array<{ k: string, v: string }>} [customAttributions]
 *   Arbitrary custom attribution entries, matching the `customAttributions`
 *   shape accepted by the REST PATCH and WS upgrade query param. Each entry
 *   produces `insert:${k}` / `delete:${k}` content attributes on the agent's
 *   inserts and deletes.
 */

/**
 * Run an LLM agent task against `room`. The handler receives a freshly hydrated
 * `Y.Doc` (snapshot of the room's current state) and a new `Awareness` bound to
 * it. Mutations to either are streamed to all connected clients in real time
 * with attributions derived from `author` / `promptBy`. After the handler
 * resolves the agent's awareness is cleared (immediately or after a delay), and
 * only then does the returned promise resolve. Handler errors and forwarding
 * errors are surfaced to the caller; on any error, awareness is cleared
 * immediately regardless of `clearAwareness`.
 *
 * @template R
 * @param {import('./index.js').YHub} yhub
 * @param {import('./types.js').Room} room
 * @param {AgentTaskOptions} opts
 * @param {(ydoc: Y.Doc, awareness: awarenessProtocol.Awareness) => Promise<R> | R} handler
 * @returns {Promise<R>}
 */
export const agentTask = async (
  yhub,
  room,
  { clearAwareness = 0, author, displayedAuthor = author, promptBy, customAttributions = [] } = /** @type {AgentTaskOptions} */ ({}),
  handler
) => {
  const doctable = await yhub.getDoc(room, { nongc: true })
  const ydoc = new Y.Doc()
  if (doctable.nongcDoc) Y.applyUpdate(ydoc, doctable.nongcDoc)
  const awareness = new awarenessProtocol.Awareness(ydoc)
  const mergedAttrs = promptBy != null ? customAttributions.concat([{ k: 'promptBy', v: promptBy }]) : customAttributions
  /** @type {Error | null} */
  let pendingError = null
  /**
   * @param {any} err
   * @param {string} ctx
   */
  const captureErr = (err, ctx) => {
    log.error({ err, room }, ctx)
    if (pendingError == null) pendingError = /** @type {Error} */ (err)
  }

  /**
   * @param {Uint8Array<ArrayBuffer>} update
   */
  const onUpdate = (update) => {
    if (update.byteLength <= 3) return
    const now = time.getUnixTime()
    const insertAttrs = [Y.createContentAttribute('insertAt', now),
      ...mergedAttrs.map(a => Y.createContentAttribute('insert:' + a.k, a.v))]
    const deleteAttrs = [Y.createContentAttribute('deleteAt', now),
      ...mergedAttrs.map(a => Y.createContentAttribute('delete:' + a.k, a.v))]
    if (author != null) {
      insertAttrs.unshift(Y.createContentAttribute('insert', author))
      deleteAttrs.unshift(Y.createContentAttribute('delete', author))
    }
    const contentmap = Y.encodeContentMap(Y.createContentMapFromContentIds(
      Y.createContentIdsFromUpdate(update),
      insertAttrs,
      deleteAttrs
    ))
    yhub.stream.addMessage(room, { type: 'ydoc:update:v1', update, contentmap })
      .catch(err => captureErr(err, 'failed to forward agent ydoc update'))
  }

  /**
   * @param {{ added: number[], updated: number[], removed: number[] }} changes
   */
  const onAwareness = ({ added, updated, removed }) => {
    const clients = added.concat(updated, removed)
    if (clients.length === 0) return
    const update = /** @type {Uint8Array<ArrayBuffer>} */ (awarenessProtocol.encodeAwarenessUpdate(awareness, clients))
    yhub.stream.addMessage(room, { type: 'awareness:v1', update })
      .catch(err => captureErr(err, 'failed to forward agent awareness update'))
  }

  ydoc.on('update', onUpdate)
  awareness.on('update', onAwareness)

  // Seed the agent's awareness AFTER listeners are attached so connected
  // clients see the displayed name immediately.
  if (displayedAuthor != null) {
    awareness.setLocalState({ user: { name: displayedAuthor } })
  }

  /** @type {R | undefined} */
  let result
  try {
    result = await handler(ydoc, awareness)
  } catch (err) {
    captureErr(err, 'agent handler threw')
  }
  ydoc.off('update', onUpdate)
  awareness.off('update', onAwareness)

  // On success with clearAwareness=false, skip the disconnect entirely.
  // On error, always clear immediately regardless of clearAwareness.
  const skipClear = pendingError == null && clearAwareness === false
  if (!skipClear) {
    const delayMs = pendingError != null ? 0 : /** @type {number} */ (clearAwareness) * 1000
    if (delayMs > 0) await promise.wait(delayMs)
    const meta = awareness.meta.get(awareness.clientID)
    const disconnect = protocol.encodeAwarenessUserDisconnected(awareness.clientID, meta?.clock ?? 0)
    try {
      await yhub.stream.addMessage(room, { type: 'awareness:v1', update: disconnect })
    } catch (err) {
      captureErr(err, 'failed to clear agent awareness')
    }
  }
  awareness.destroy()
  ydoc.destroy()

  if (pendingError != null) throw pendingError
  return /** @type {R} */ (result)
}
