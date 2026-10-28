import { parentPort } from 'node:worker_threads'
import * as Y from '@y/y'
import * as encoding from 'lib0/encoding'
import * as delta from 'lib0/delta'
import { createContentMap, mergeUpdates, computeSyncSteps } from './y-utils.js'
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

const port = parentPort

/**
 * @param {import('./compute.js').ComputeTask} msg
 */
const runTask = msg => {
  log.debug({ type: msg.type }, 'new compute task')
  switch (msg.type) {
    case 'mergeUpdates': {
      const result = mergeUpdates(msg.gc, msg.updates, msg.prune)
      port.postMessage(result, [result.buffer])
      break
    }
    case 'computePruneSet': {
      const { contentmapBin, from, to, by, contentIds: contentIdsBin, withCustomAttributions = null } = msg
      const contentmap = Y.decodeContentMap(contentmapBin)
      const contentIds = contentIdsBin && Y.decodeContentIds(contentIdsBin)
      const filtered = filterContentMap(contentmap, from, to, by, contentIds, withCustomAttributions)
      const { inserts, deletes } = Y.createContentIdsFromContentMap(filtered)
      const pruneSet = Y.intersectSets(inserts, deletes)
      if (pruneSet.clients.size === 0) {
        port.postMessage(null)
      } else {
        const result = Y.encodeIdSet(pruneSet)
        port.postMessage(result, [result.buffer])
      }
      break
    }
    case 'computeSyncSteps': {
      const result = computeSyncSteps(msg.update, msg.sv, msg.withSv)
      port.postMessage(result, result.sv === null ? [result.diff.buffer] : [result.diff.buffer, result.sv.buffer])
      break
    }
    case 'changeset': {
      const { nongcDoc: nongcDocBin, contentmapBin, from, to, by, withCustomAttributions, includeYdoc, includeDelta, includeDiff, includeAttributions, t } = msg
      const contentmap = Y.decodeContentMap(contentmapBin)
      const filteredAttributions = filterContentMap(contentmap, from ?? undefined, to ?? undefined, by || undefined, undefined, withCustomAttributions)
      const afterContentIds = Y.createContentIdsFromContentMap(filterContentMap(contentmap, 0, to ?? undefined, undefined, undefined, null))
      /** @type {any} */
      const response = { t }
      if (includeAttributions) {
        response.attributions = Y.encodeContentMap(filteredAttributions)
      }
      if (includeYdoc || includeDelta || includeDiff) {
        // The document as it was at `to`: a gc:false prefix of the nongc doc (content up to `to`),
        // with deleted content outside the changeset's attribution window garbage-collected away. Its
        // alive content is exactly the state at `to`, so the AttributionsRenderer overlay (attributions
        // alone, no renderedContent) renders the diff.
        const doc = new Y.Doc({ gc: false })
        Y.applyUpdate(doc, Y.intersectUpdateWithContentIds(nongcDocBin, afterContentIds))
        Y.gcIdSet(doc, Y.diffIdSet(afterContentIds.deletes, filteredAttributions.deletes))
        if (includeDelta) {
          response.delta = doc.get().toDelta({ renderer: Y.createAttributionsRenderer(filteredAttributions) }).toJSON()
        }
        if (includeDiff) {
          // the change alone, as an observeDeep event per root type, wrapped the way
          // `Y.diffDocsToDelta` wraps them. The changed ids are (I−D) ∪ (D−I): content inserted
          // *and* deleted inside the window is churn and renders as nothing.
          const { inserts, deletes } = Y.createContentIdsFromContentMap(filteredAttributions)
          const itemsToRender = Y.mergeIdSets([Y.diffIdSet(inserts, deletes), Y.diffIdSet(deletes, inserts)])
          const modified = Y.computeModifiedFromItems(doc.store, itemsToRender)
          const diff = delta.create()
          doc.share.forEach((type, name) => { modified.has(type) && diff.modifyAttr(name, type.toDelta({ renderer: null, deep: true, itemsToRender, retainDeletes: true, modified })) })
          response.diff = modified.size === 0 ? null : diff.done().toJSON()
        }
        if (includeYdoc) {
          response.ydoc = Y.encodeStateAsUpdate(doc)
        }
        doc.destroy()
      }
      const encoder = encoding.createEncoder()
      encoding.writeAny(encoder, response)
      const result = encoding.toUint8Array(encoder)
      port.postMessage(result, [result.buffer])
      break
    }
    case 'activity': {
      const { nongcDoc: nongcDocBin, contentmapBin, from, to, by, contentIds: contentIdsBin, withCustomAttributions, includeCustomAttributions, includeDelta, includeYdoc, includeAttributions, limit, reverse, group, groupByUser, groupMaxGap, groupMaxDuration, groupExclude, versions = [] } = msg
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
          } else if (customAttributions != null && attr.name.startsWith('delete:')) {
            customAttributions.push({ k: attr.name.slice(7), v: attr.val })
          }
        })
        if (t != null) {
          activity.push({ from: t, to: t, by: actBy, customAttributions })
        }
      })
      activity.sort((a, b) => a.from - b.from)
      /** @type {Array<{ from: number, to: number, by: string|null|Array<string|null>, delta?: any, attributions?: Uint8Array<ArrayBuffer>, renderedContent?: Uint8Array<ArrayBuffer>, customAttributions: Array<{k:string,v:string}>|null, version?: import('./types.js').Version, isEmpty?: boolean }>} */
      const activityResult = []
      const groupDistance = group ? groupMaxGap : 1
      /**
       * The open entry - changes may still merge into it. `null` after a named version closed it.
       *
       * @type {{ from: number, to: number, by: string|null|Array<string|null>, customAttributions: Array<{k:string,v:string}>|null, version?: import('./types.js').Version }|null}
       */
      let lastActivity = null
      // the previous change's author - with `groupByUser:false` an entry's `by` is its author list,
      // so it can no longer answer "who wrote the change before this one"
      /** @type {string?} */
      let lastBy = null
      // the open entry's author list (`groupByUser:false` only)
      /** @type {Array<string|null>?} */
      let byList = null
      // the first named version that is not applied yet
      let vi = 0
      /**
       * Apply every named version before `t` - strictly: a change at exactly the time of a version
       * belongs to it. A version closes the open entry at its time, whatever the gap, so no entry
       * spans it; with no change since the previous cut it is an entry of its own, flagged
       * `isEmpty`. Filters never hide a version.
       *
       * @param {number} t
       */
      const cutVersions = t => {
        while (vi < versions.length && versions[vi].t < t) {
          const version = versions[vi++]
          if (lastActivity != null) {
            lastActivity.to = version.t
            lastActivity.version = version
            lastActivity = null
          } else {
            activityResult.push({ from: version.t, to: version.t, by: groupByUser ? null : [], customAttributions: includeCustomAttributions ? [] : null, version, isEmpty: true })
          }
        }
      }
      activity.forEach(act => {
        cutVersions(act.from)
        // a groupExclude'd user never merges in either direction - null authors are never excludable
        const excluded = (act.by != null && groupExclude.includes(act.by)) || (lastBy != null && groupExclude.includes(lastBy))
        if (lastActivity != null && !excluded && (!groupByUser || lastBy === act.by) && act.from - lastActivity.to < groupDistance && act.to - lastActivity.from < groupMaxDuration) {
          lastActivity.to = act.to
          lastActivity.customAttributions?.push(...(act?.customAttributions || []))
          if (byList != null && !byList.includes(act.by)) byList.push(act.by)
        } else {
          byList = groupByUser ? null : [act.by]
          lastActivity = groupByUser ? act : { ...act, by: byList }
          activityResult.push(lastActivity)
        }
        lastBy = act.by
      })
      cutVersions(Infinity)
      if (includeCustomAttributions) {
        // the result entries, not `activity`: with `groupByUser:false` a group head is a copy, and
        // this reassigns `customAttributions` rather than mutating it in place
        activityResult.forEach(act => {
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
      /** @type {Uint8Array<ArrayBuffer>|null} */
      let ydocOut = null
      if (includeYdoc || includeDelta || includeAttributions) {
        // A single gc:false doc shared across every entry: the nongc prefix up to the latest `to`.
        // Each entry is re-projected back to its own `act.to` via its `renderedContent` IdSet.
        const maxTo = activityResult.reduce((m, a) => Math.max(m, a.to), 0)
        const docContentIds = Y.createContentIdsFromContentMap(filterContentMap(contentmap, 0, maxTo, undefined, undefined, null))
        const doc = new Y.Doc({ gc: false })
        Y.applyUpdate(doc, Y.intersectUpdateWithContentIds(nongcDocBin, docContentIds))
        const root = doc.share.keys().next().value || ''
        // Per-entry attribution overlay (`attrs`, uniformly stamped as the entry's author/time
        // while `groupByUser` holds) and point-in-time baseline (`renderedContent` = content alive
        // at the entry's `to`).
        const perItem = activityResult.map(act => {
          const actAttributions = filterContentMap(filteredAttributions, act.from, act.to, undefined, undefined, null)
          // a `groupByUser:false` entry can have several authors - its original per-change
          // attributions carry each author and its real timestamp, a uniform stamp could not
          const attrs = groupByUser
            ? Y.createContentMapFromContentIds(Y.createContentIdsFromContentMap(actAttributions), [Y.createContentAttribute('insert', act.by), Y.createContentAttribute('insertAt', act.from)], [Y.createContentAttribute('delete', act.by), Y.createContentAttribute('deleteAt', act.from)])
            : actAttributions
          const afterContentIds = Y.createContentIdsFromContentMap(filterContentMap(contentmap, 0, act.to, undefined, undefined, null))
          return { attrs, renderedContent: Y.diffIdSet(afterContentIds.inserts, afterContentIds.deletes) }
        })
        if (includeYdoc) {
          // Drop deleted content that no entry renders and that isn't attributed, shrinking the doc we
          // ship. Everything kept stays restorable (gc:false); gcIdSet only collects deleted structs.
          const keep = Y.mergeIdSets([...perItem.map(p => p.renderedContent), Y.createIdSetFromIdMap(filteredAttributions.inserts), Y.createIdSetFromIdMap(filteredAttributions.deletes)])
          Y.gcIdSet(doc, Y.diffIdSet(docContentIds.deletes, keep))
        }
        activityResult.forEach((act, i) => {
          const { attrs, renderedContent } = perItem[i]
          if (includeDelta) {
            act.delta = doc.get(root).toDeltaDeep({ renderer: Y.createAttributionsRenderer(attrs, { renderedContent }) }).toJSON()
          }
          if (includeAttributions) {
            act.attributions = Y.encodeContentMap(attrs)
          }
          if (includeYdoc) {
            act.renderedContent = Y.encodeIdSet(renderedContent)
          }
        })
        if (includeYdoc) {
          ydocOut = Y.encodeStateAsUpdate(doc)
        }
        doc.destroy()
      }
      const encoder = encoding.createEncoder()
      // response is always `{ activity, ydoc? }` — the top-level shape is stable regardless of `ydoc`.
      // A version's `custom` is typed `any`, which the encodable type doesn't admit
      encoding.writeAny(encoder, /** @type {any} */ (includeYdoc ? { ydoc: ydocOut, activity: activityResult } : { activity: activityResult }))
      const result = encoding.toUint8Array(encoder)
      port.postMessage(result, [result.buffer])
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
      Y.undoContentIds(ydoc, revertIds, { ignoreRemoteAttributeChanges: true })
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
}

port.on('message', /** @param {import('./compute.js').ComputeTask} msg */ msg => {
  try {
    runTask(msg)
  } catch (err) {
    // a task that throws - on malformed input, like a client's state vector - fails alone: the
    // error rejects it (see `ComputeWorker`) and the thread stays alive for the next task
    port.postMessage(err)
  }
})
