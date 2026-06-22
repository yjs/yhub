import * as env from 'lib0/environment'
import * as Y from '@y/y'
import { applyUpdates } from '@y-crdt/yn'
import { logger } from './logger.js'

const useYNative = ['true', '1'].includes(env.getConf('use-y-native') ?? '')

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
 * When `prune` (a serialized `IdSet`) is provided, the referenced content is
 * garbage-collected after merging. This forces the `@y/y` path (the native
 * binding can't `gcIdSet`) and is used to permanently prune churned history.
 *
 * @param {boolean} gc
 * @param {Array<Uint8Array<ArrayBuffer>>} updates
 * @param {Uint8Array<ArrayBuffer>} [prune]
 * @returns {Uint8Array<ArrayBuffer>}
 */
export const mergeUpdates = (gc, updates, prune) => {
  if (useYNative && prune == null) {
    return /** @type {Uint8Array<ArrayBuffer>} */ (applyUpdates(gc, updates))
  }
  if (!gc && prune == null) {
    return Y.mergeUpdates(updates)
  }
  const ydoc = new Y.Doc({ gc })
  ydoc.transact(() => {
    updates.forEach(update => Y.applyUpdate(ydoc, update))
  })
  if (prune != null) {
    Y.gcIdSet(ydoc, Y.decodeIdSet(prune))
  }
  const result = Y.encodeStateAsUpdate(ydoc)
  ydoc.destroy()
  return result
}
