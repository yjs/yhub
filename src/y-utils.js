import * as env from 'lib0/environment'
import * as time from 'lib0/time'
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
  // a single update is already merged unless it needs to be garbage-collected
  if (updates.length === 1 && !gc && prune == null) {
    return updates[0]
  }
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

/**
 * The server's part of the sync handshake with a client that sent the state vector `clientSv`:
 * `diff`, the part of `update` the client lacks (the server's sync step 2), and - only `withSv` -
 * `sv`, the state vector of `update` (the server's sync step 1). A client without state gets
 * `update` itself - diffing against an empty state vector would only re-encode the whole
 * document. An encoded state vector starts with its number of clients as a varuint, whose first
 * byte is 0 only for 0.
 *
 * @param {Uint8Array<ArrayBuffer>} update
 * @param {Uint8Array<ArrayBuffer>} clientSv
 * @param {boolean} withSv
 * @return {{ diff: Uint8Array<ArrayBuffer>, sv: Uint8Array<ArrayBuffer>|null }}
 */
export const computeSyncSteps = (update, clientSv, withSv) => ({
  diff: clientSv[0] === 0 ? update : Y.diffUpdate(update, clientSv),
  sv: withSv ? Y.encodeStateVectorFromUpdate(update) : null
})

/**
 * The contentmap of an update: every id it inserts or deletes, attributed to `userid` now plus the
 * caller's custom attributions. The map may cover a whole-document body - `getDoc` keeps only the
 * ids it has not accepted before.
 *
 * @param {Y.ContentIds} contentids
 * @param {string} userid
 * @param {Array<{ k: string, v: string }>} customAttributions
 */
export const createContentMap = (contentids, userid, customAttributions) => {
  const now = time.getUnixTime()
  return Y.encodeContentMap(Y.createContentMapFromContentIds(
    contentids,
    [Y.createContentAttribute('insert', userid), Y.createContentAttribute('insertAt', now), ...customAttributions.map(attr => Y.createContentAttribute('insert:' + attr.k, attr.v))],
    [Y.createContentAttribute('delete', userid), Y.createContentAttribute('deleteAt', now), ...customAttributions.map(attr => Y.createContentAttribute('delete:' + attr.k, attr.v))]
  ))
}
