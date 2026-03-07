import { parentPort } from 'node:worker_threads'
import * as Y from '@y/y'
import * as time from 'lib0/time'
import * as encoding from 'lib0/encoding'
import { logger } from './logger.js'

const log = logger.child({ module: 'compute-worker' })

if (parentPort == null) {
  throw new Error('Unable to run node worker!')
}

/**
 * @param {Y.ContentMap} contentMap
 * @param {number | undefined} from
 * @param {number | undefined} to
 * @param {string | undefined} by
 * @param {Y.ContentIds | undefined} requestedIds
 * @param {Array<{k: string, v: string}> | null} customAttributions
 */
const filterContentMap = (contentMap, from, to, by, requestedIds, customAttributions) => {
  if (requestedIds != null) {
    contentMap = Y.intersectContentMap(contentMap, requestedIds)
  }
  if (from || to || by || (customAttributions != null && customAttributions.length > 0)) {
    /**
     * @param {Array<Y.ContentAttribute<any>>} attrs
     */
    const attrFilter = attrs => {
      if ((from || to) && !attrs.some(attr => (attr.name === 'insertAt' || attr.name === 'deleteAt') && (from == null || attr.val >= from) && (to == null || attr.val <= to))) {
        return false
      }
      if (by != null && !attrs.some(attr => (attr.name === 'insert' || attr.name === 'delete') && /** @type {string} */ (attr.val).split(',').includes(by))) {
        return false
      }
      if (customAttributions != null && !customAttributions.every(customAttr => attrs.some(attr => {
        if (attr.name.startsWith('insert:') || attr.name.startsWith('delete:')) {
          const arest = attr.name.slice(7)
          return arest === customAttr.k && attr.val === customAttr.v
        }
        return false
      }))) {
        return false
      }
      return true
    }
    contentMap = Y.filterContentMap(contentMap, attrFilter, attrFilter)
  }
  return contentMap
}

/**
 * @param {Y.ContentIds} contentids
 * @param {string} userid
 * @param {Array<{k: string, v: string}>} customAttributions
 */
const createContentMap = (contentids, userid, customAttributions) => {
  const now = time.getUnixTime()
  return Y.encodeContentMap(Y.createContentMapFromContentIds(
    contentids,
    [Y.createContentAttribute('insert', userid), Y.createContentAttribute('insertAt', now), ...customAttributions.map(attr => Y.createContentAttribute('insert:' + attr.k, attr.v))],
    [Y.createContentAttribute('delete', userid), Y.createContentAttribute('deleteAt', now), ...customAttributions.map(attr => Y.createContentAttribute('delete:' + attr.k, attr.v))]
  ))
}

const port = parentPort
port.on('message', /** @param {import('./compute.js').ComputeTask} msg */ msg => {
  log.debug({ type: msg.type }, 'new compute task')
  switch (msg.type) {
    case 'mergeUpdatesAndGc': {
      const ydoc = new Y.Doc()
      ydoc.transact(() => {
        msg.updates.forEach(/** @param {Uint8Array} update */ update => {
          Y.applyUpdate(ydoc, update)
        })
      })
      const result = Y.encodeStateAsUpdate(ydoc)
      ydoc.destroy()
      port.postMessage(result, [result.buffer])
      break
    }
    case 'mergeUpdates': {
      const result = Y.mergeUpdates(msg.updates)
      port.postMessage(result, [result.buffer])
      break
    }
    case 'changeset': {
      const { nongcDoc: nongcDocBin, contentmapBin, from, to, by, withCustomAttributions, includeYdoc, includeDelta, includeAttributions } = msg
      const contentmap = Y.decodeContentMap(contentmapBin)
      const filteredAttributions = filterContentMap(contentmap, from ?? undefined, to ?? undefined, by || undefined, undefined, withCustomAttributions)
      const beforeContentIds = Y.createContentIdsFromContentMap(filterContentMap(contentmap, 0, from != null ? from - 1 : undefined, undefined, undefined, null))
      const afterContentIds = Y.createContentIdsFromContentMap(filterContentMap(contentmap, 0, to ?? undefined, undefined, undefined, null))
      const prevDocUpdate = Y.intersectUpdateWithContentIds(nongcDocBin, beforeContentIds)
      const nextDocUpdate = Y.intersectUpdateWithContentIds(nongcDocBin, afterContentIds)
      /** @type {any} */
      const response = {}
      if (includeAttributions) {
        response.attributions = Y.encodeContentMap(filteredAttributions)
      }
      if (includeYdoc || includeDelta) {
        if (includeYdoc) {
          response.prevDoc = prevDocUpdate
          response.nextDoc = nextDocUpdate
        }
        if (includeDelta) {
          const prevDoc = new Y.Doc()
          const nextDoc = new Y.Doc()
          Y.applyUpdate(prevDoc, prevDocUpdate)
          Y.applyUpdate(nextDoc, nextDocUpdate)
          const am = Y.createAttributionManagerFromDiff(prevDoc, nextDoc, { attrs: filteredAttributions })
          response.delta = nextDoc.get().toDelta(am).toJSON()
          prevDoc.destroy()
          nextDoc.destroy()
        }
      }
      const encoder = encoding.createEncoder()
      encoding.writeAny(encoder, response)
      const result = encoding.toUint8Array(encoder)
      port.postMessage(result, [result.buffer])
      break
    }
    case 'activity': {
      const { nongcDoc: nongcDocBin, contentmapBin, from, to, by, contentIds: contentIdsBin, withCustomAttributions, includeCustomAttributions, includeDelta, limit, reverse, group } = msg
      const contentmap = Y.decodeContentMap(contentmapBin)
      const contentIds = contentIdsBin && Y.decodeContentIds(contentIdsBin)
      const filteredAttributions = filterContentMap(contentmap, from, to, by || undefined, contentIds, withCustomAttributions)
      /**
       * @type {Array<{ from: number, to: number, by: string|null, customAttributions: { k: string, v: string}[]|null }>}
       */
      const activity = []
      filteredAttributions.inserts.forEach(attrRange => {
        /** @type {number?} */
        let t = null
        /** @type {string?} */
        let actBy = null
        /** @type {Array<{k:string,v:string}>|null} */
        const customAttributions = includeCustomAttributions ? [] : null
        attrRange.attrs.forEach(attr => {
          if (attr.name === 'insertAt') {
            t = attr.val
          } else if (attr.name === 'insert') {
            actBy = attr.val
          } else if (customAttributions != null && attr.name.startsWith('insert:')) {
            customAttributions.push({ k: attr.name.slice(7), v: attr.val })
          }
        })
        if (t != null) {
          activity.push({ from: t, to: t, by: actBy, customAttributions })
        }
      })
      filteredAttributions.deletes.forEach(attrRange => {
        /** @type {number?} */
        let t = null
        /** @type {string?} */
        let actBy = null
        /** @type {Array<{k:string,v:string}>|null} */
        const customAttributions = includeCustomAttributions ? [] : null
        attrRange.attrs.forEach(attr => {
          if (attr.name === 'deleteAt') {
            t = attr.val
          } else if (attr.name === 'delete') {
            actBy = attr.val
          } else if (customAttributions != null && attr.name.startsWith('insert:')) {
            customAttributions.push({ k: attr.name.slice(7), v: attr.val })
          }
        })
        if (t != null) {
          activity.push({ from: t, to: t, by: actBy, customAttributions })
        }
      })
      activity.sort((a, b) => a.from - b.from)
      /** @type {Array<{ from: number, to: number, by: string?, delta?: any, customAttributions: Array<{k:string,v:string}>|null }>} */
      const activityResult = []
      const groupDistance = group ? 1000 : 1
      /** @type {{ from: number, to: number, by: string?, customAttributions: Array<{k:string,v:string}>|null }|null} */
      let lastActivity = null
      activity.forEach(act => {
        if (lastActivity != null && lastActivity.by === act.by && act.from - lastActivity.to < groupDistance) {
          lastActivity.to = act.to
          lastActivity.customAttributions?.push(...(act?.customAttributions || []))
        } else {
          activityResult.push(act)
          lastActivity = act
        }
      })
      if (includeCustomAttributions) {
        activity.forEach(act => {
          /** @type {Array<{k:string,v:string}>} */
          const uniqueCustomAttrs = []
          const unique = new Set()
          act.customAttributions?.forEach(c => {
            const uniqueKey = c.k + '_' + c.v
            if (!unique.has(uniqueKey)) {
              unique.add(uniqueKey)
              uniqueCustomAttrs.push(c)
            }
          })
          act.customAttributions = uniqueCustomAttrs
        })
      }
      if (reverse) {
        activityResult.reverse()
      }
      if (limit > 0) {
        activityResult.splice(limit)
      }
      if (includeDelta) {
        activityResult.forEach(act => {
          const actAttributions = filterContentMap(filteredAttributions, act.from, act.to, undefined, undefined, null)
          const beforeContentIds = Y.createContentIdsFromContentMap(filterContentMap(contentmap, 0, act.from != null ? act.from - 1 : undefined, undefined, undefined, null))
          const afterContentIds = Y.createContentIdsFromContentMap(filterContentMap(contentmap, 0, act.to, undefined, undefined, null))
          const prevDocUpdate = Y.intersectUpdateWithContentIds(nongcDocBin, beforeContentIds)
          const nextDocUpdate = Y.intersectUpdateWithContentIds(nongcDocBin, afterContentIds)
          const prevDoc = new Y.Doc()
          const nextDoc = new Y.Doc()
          Y.applyUpdate(prevDoc, prevDocUpdate)
          Y.applyUpdate(nextDoc, nextDocUpdate)
          const attrs = Y.createContentMapFromContentIds(Y.createContentIdsFromContentMap(actAttributions), [Y.createContentAttribute('insert', act.by), Y.createContentAttribute('insertAt', act.from)], [Y.createContentAttribute('delete', act.by), Y.createContentAttribute('deleteAt', act.from)])
          const am = Y.createAttributionManagerFromDiff(prevDoc, nextDoc, { attrs })
          act.delta = nextDoc.get(nextDoc.share.keys().next().value || '').toDeltaDeep(am).toJSON()
          prevDoc.destroy()
          nextDoc.destroy()
        })
      }
      const encoder = encoding.createEncoder()
      encoding.writeAny(encoder, activityResult)
      const result = encoding.toUint8Array(encoder)
      port.postMessage(result, [result.buffer])
      break
    }
    case 'patchYdoc': {
      const { update, currentDoc, userid, customAttributions = [] } = msg
      const currentContentIds = Y.createContentIdsFromUpdate(currentDoc)
      const newContentIds = Y.excludeContentIds(Y.createContentIdsFromUpdate(update), currentContentIds)
      const diffedUpdate = /** @type {Uint8Array<ArrayBuffer>} */ (Y.intersectUpdateWithContentIds(update, newContentIds))
      if (diffedUpdate.byteLength > 3) {
        const contentmap = createContentMap(Y.createContentIdsFromUpdate(diffedUpdate), userid, customAttributions)
        port.postMessage({ update: diffedUpdate, contentmap }, [diffedUpdate.buffer, contentmap.buffer])
      } else {
        port.postMessage(null)
      }
      break
    }
    case 'rollback': {
      const { nongcDoc, contentmapBin, from, to, by, contentIds: contentIdsBin, withCustomAttributions = null, userid, customAttributions = [] } = msg
      const contentmap = Y.decodeContentMap(contentmapBin)
      const contentIds = contentIdsBin && Y.decodeContentIds(contentIdsBin)
      const reducedAttributions = filterContentMap(contentmap, from, to, by, contentIds, withCustomAttributions)
      const revertIds = Y.createContentIdsFromContentMap(reducedAttributions)
      const ydoc = new Y.Doc({ gc: false })
      Y.applyUpdate(ydoc, nongcDoc)
      let update = /** @type {Uint8Array<ArrayBuffer> | null} */ (null)
      ydoc.once('update', (/** @type {Uint8Array<ArrayBuffer>} */ u) => { update = u })
      Y.undoContentIds(ydoc, revertIds, { ignoreRemoteMapChanges: true })
      ydoc.destroy()
      if (update != null) {
        const resultContentmap = createContentMap(Y.createContentIdsFromUpdate(update), userid, customAttributions)
        port.postMessage({ update, contentmap: resultContentmap }, [update.buffer, resultContentmap.buffer])
      } else {
        port.postMessage({ update: null, contentmap: null })
      }
      break
    }
  }
})
