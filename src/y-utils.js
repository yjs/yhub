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
 * The contentmap of an update: every id it inserts or deletes, attributed to `userid` (none for
 * `null`) plus the caller's custom attributions. It says who, never when - `getDoc` stamps the time
 * when it reads the message from the stream (`stampContentMap`). The map may cover a
 * whole-document body - `getDoc` keeps only the ids it has not accepted before.
 *
 * @param {Y.ContentIds} contentids
 * @param {string|null} userid
 * @param {Array<{ k: string, v: string }>} customAttributions
 */
export const createContentMap = (contentids, userid, customAttributions) => Y.encodeContentMap(Y.createContentMapFromContentIds(
  contentids,
  [...(userid == null ? [] : [Y.createContentAttribute('insert', userid)]), ...customAttributions.map(attr => Y.createContentAttribute('insert:' + attr.k, attr.v))],
  [...(userid == null ? [] : [Y.createContentAttribute('delete', userid)]), ...customAttributions.map(attr => Y.createContentAttribute('delete:' + attr.k, attr.v))]
))

/**
 * The attributions of a message read from the stream: its contentmap, every id stamped with `ms` -
 * the time of the message's stream id. Attribution times are stream time, never a server's clock.
 *
 * @param {Y.ContentMap} contentmap
 * @param {number} ms
 * @return {Y.ContentMap}
 */
export const stampContentMap = (contentmap, ms) => {
  /**
   * @param {Y.IdMap<any>} idmap
   * @param {Y.ContentAttribute<number>} at
   */
  const stamp = (idmap, at) => {
    const res = Y.createIdMap()
    idmap.forEach((r, client) => res.add(client, r.clock, r.len, r.attrs.filter(a => a.name !== at.name).concat(at)))
    return res
  }
  return Y.createContentMap(stamp(contentmap.inserts, Y.createContentAttribute('insertAt', ms)), stamp(contentmap.deletes, Y.createContentAttribute('deleteAt', ms)))
}
