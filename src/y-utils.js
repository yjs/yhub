import * as env from 'lib0/environment'
import * as Y from '@y/y'
import { applyUpdates } from '@y-crdt/yn'
import { logger } from './logger.js'

const useYNative = env.hasConf('use-y-native')

if (useYNative) {
  logger.warn('using experimental y-native')
}

/**
 * Merge a set of v1-encoded updates into a single v1 update.
 *
 * When `gc` is `true`, deleted content is garbage-collected; when `false` it is
 * retained. With the `use-y-native` conf set, the merge is delegated to the
 * native yrs (Rust) binding (`@y-crdt/yn`); otherwise it runs on `@y/y`.
 *
 * @param {boolean} gc
 * @param {Array<Uint8Array<ArrayBuffer>>} updates
 * @returns {Uint8Array<ArrayBuffer>}
 */
export const mergeUpdates = (gc, updates) => {
  if (useYNative) {
    return /** @type {Uint8Array<ArrayBuffer>} */ (applyUpdates(gc, updates))
  }
  if (!gc) {
    return Y.mergeUpdates(updates)
  }
  const ydoc = new Y.Doc()
  ydoc.transact(() => {
    updates.forEach(update => Y.applyUpdate(ydoc, update))
  })
  const result = Y.encodeStateAsUpdate(ydoc)
  ydoc.destroy()
  return result
}
