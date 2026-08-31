import * as Y from '@y/y'
import * as buffer from 'lib0/buffer'
import * as decoding from 'lib0/decoding'
import * as math from 'lib0/math'
import * as number from 'lib0/number'
import * as s from 'lib0/schema'
import { createApiEndpoint, DocDeletedError } from './types.js'
import { createDocumentPermissions, hasPermissions } from './permissions.js'
// benign import cycle with api.js - apiError/checkPermissions are only referenced at request
// time, never during module evaluation
import { apiError, checkPermissions, encodedAny } from './api.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'api' })

const $kv = s.$object({ k: s.$string, v: s.$string })

/**
 * Parse a `k:v,k:v` custom-attributions query param.
 *
 * @param {string|undefined} param
 * @returns {Array<{k: string, v: string}>}
 */
export const parseCustomAttributionsParam = (param) =>
  param ? param.split(',').map(entry => { const [k, ...rest] = entry.split(':'); return { k, v: rest.join(':') } }) : []

const ydocEndpoint = createApiEndpoint('ydoc', {
  get: {
    $query: { gc: s.$boolean.optional, awareness: s.$boolean.optional },
    handler: async req => {
      const gc = req.query.gc ?? true
      const includeAwareness = req.query.awareness ?? false
      // the nongc doc *is* the full history - a bounded history ray is unenforceable on it, so
      // gc=false demands the full ray explicitly rather than silently downgrading to gc=true
      checkPermissions(req.permissions, createDocumentPermissions({ ydoc: '-r--', ...(includeAwareness && { awareness: '-r--' }), ...(gc ? null : { history: { from: 0 } }) }))
      try {
        const { gcDoc, nongcDoc, awareness, tombstone } = await req.yhub.getDoc(req.docRef, { gc, nongc: !gc, awareness: includeAwareness }, { gcOnMerge: false })
        if (tombstone != null) throw new DocDeletedError(req.docRef, tombstone)
        /**
         * @type {{ doc: Uint8Array, awareness?: Uint8Array }}
         */
        const body = { doc: gcDoc || nongcDoc || Y.encodeStateAsUpdate(new Y.Doc()) }
        // mergeAwarenessUpdates returns wire-format (messageAwareness uint + varUint8Array).
        // Strip the wrapper so the caller gets bare bytes consumable by applyAwarenessUpdate
        // and by the PATCH `awareness` field.
        if (awareness != null && awareness.byteLength > 3) {
          const dec = decoding.createDecoder(awareness)
          decoding.readVarUint(dec)
          body.awareness = decoding.readVarUint8Array(dec)
        }
        return body
      } catch (err) {
        // a deleted document is not a server error - registerApi turns this into a 404
        if (err instanceof DocDeletedError) throw err
        log.error({ err, docRef: req.docRef }, 'error handling ydoc request')
        throw apiError(500, 'Failed to retrieve document')
      }
    }
  },
  delete: {
    $query: { hard: s.$boolean.optional },
    handler: async req => {
      const hard = req.query.hard ?? false
      const kind = /** @type {'soft'|'hard'} */ (hard ? 'hard' : 'soft')
      checkPermissions(req.permissions, createDocumentPermissions({ delete: [kind] }))
      const tombstone = await req.yhub.deleteDoc(req.docRef, { hard, by: req.authInfo?.userid ?? null })
      return { deletedAt: tombstone.deletedAt, hard: tombstone.hard, by: tombstone.by }
    }
  },
  patch: {
    $body: { update: s.$uint8Array.optional, awareness: s.$uint8Array.optional, customAttributions: s.$array($kv).optional },
    handler: async req => {
      const { update, customAttributions = [] } = req.body
      if (update == null && req.body.awareness == null) {
        throw apiError(400, 'Invalid request body')
      }
      // presence without awareness `u` is dropped, not refused - same as a cursor sent over a
      // socket lacking the bit. Only the update leg is a hard requirement, checked before the
      // first stream write
      const awareness = req.body.awareness != null && hasPermissions(req.permissions, createDocumentPermissions({ awareness: '--u-' })) ? req.body.awareness : null
      if (update != null) checkPermissions(req.permissions, createDocumentPermissions({ ydoc: '--u-' }))
      // attributions carry the userid - permission first (403 names what is missing), identity second
      if (update != null && req.authInfo == null) throw apiError(401, 'writing the document requires authentication', { code: 'unauthenticated' })
      if (update != null) {
        // Get current document state to diff against
        const { gcDoc, nongcDoc, tombstone } = await req.yhub.getDoc(req.docRef, { gc: true, nongc: false }, { gcOnMerge: false })
        if (tombstone != null) throw new DocDeletedError(req.docRef, tombstone)
        const currentDoc = gcDoc || nongcDoc || Y.encodeStateAsUpdate(new Y.Doc())
        const result = await req.yhub.computePool.patchYdoc({ update, currentDoc, userid: /** @type {string} */ (req.authInfo?.userid), customAttributions }, { docRef: req.docRef })
        if (result != null) {
          await req.yhub.stream.addMessage(req.docRef, { type: 'ydoc:update:v1', contentmap: result.contentmap, update: result.update })
        }
      } else {
        // an awareness-only body never reads the document, so this is the only gate it passes -
        // writing awareness to a hard-deleted document would re-create the stream key the deletion
        // just cleared
        const tombstone = await req.yhub.persistence.retrieveTombstone(req.docRef)
        if (tombstone != null) throw new DocDeletedError(req.docRef, tombstone)
      }
      if (awareness != null) {
        await req.yhub.stream.addMessage(req.docRef, { type: 'awareness:v1', update: awareness })
      }
      return { success: true, message: 'Document updated' }
    }
  }
})

// `from`/`to` are unix ms - validated as uints so a bad bound is a 400, never a requirement error
const $rollbackBody = s.$object({ from: s.$uint.optional, to: s.$uint.optional, by: s.$string.optional, contentIds: s.$uint8Array.optional, customAttributions: s.$array($kv).optional, withCustomAttributions: s.$array($kv).optional })

const rollbackEndpoint = createApiEndpoint('rollback', {
  post: {
    $body: $rollbackBody,
    handler: async req => {
      const { from, to, by, contentIds, customAttributions = [], withCustomAttributions = null } = req.body
      if (!from && !to && !by && !contentIds && (withCustomAttributions ?? []).length === 0) {
        throw apiError(400, 'Rollback requires at least one filter (from, to, by, contentIds, or withCustomAttributions)')
      }
      // mutations refuse, never clamp: the requested range starts at `from` regardless of the
      // other filters, so a filter-only rollback is unbounded and demands the full ray - a
      // granted `from` of 0 (the epoch) admits any request. Requiring rollback also requires the
      // ydoc write it rides on (see hasPermissions).
      checkPermissions(req.permissions, createDocumentPermissions({ history: { from: from ?? 0, rollback: true } }))
      // the reverting update is attributed to the caller - see PATCH
      if (req.authInfo == null) throw apiError(401, 'writing the document requires authentication', { code: 'unauthenticated' })
      const { contentmap: contentmapBin, nongcDoc, tombstone } = await req.yhub.getDoc(req.docRef, { nongc: true, contentmap: true })
      if (tombstone != null) throw new DocDeletedError(req.docRef, tombstone)
      const { update, contentmap } = await req.yhub.computePool.rollback({ nongcDoc, contentmapBin, from, to, by, contentIds, withCustomAttributions, userid: req.authInfo.userid, customAttributions }, { docRef: req.docRef })
      if (update) {
        await req.yhub.stream.addMessage(req.docRef, { type: 'ydoc:update:v1', update, contentmap })
      }
      return { success: true, message: 'Rollback completed' }
    }
  }
})

const $pruneBody = s.$object({ from: s.$uint.optional, to: s.$uint.optional, by: s.$string.optional, contentIds: s.$uint8Array.optional, withCustomAttributions: s.$array($kv).optional })

const pruneEndpoint = createApiEndpoint('prune', {
  post: {
    $body: $pruneBody,
    handler: async req => {
      const { from, to, by, contentIds, withCustomAttributions = null } = req.body
      if (!from && !to && !by && !contentIds && (withCustomAttributions ?? []).length === 0) {
        throw apiError(400, 'Prune requires at least one filter (from, to, by, contentIds, or withCustomAttributions)')
      }
      // see rollback: mutations refuse, never clamp
      checkPermissions(req.permissions, createDocumentPermissions({ history: { from: from ?? 0, prune: true } }))
      await req.yhub.pruneDoc(req.docRef, { from, to, by, contentIds, withCustomAttributions })
      return { success: true, message: 'Prune completed' }
    }
  }
})

const changesetEndpoint = createApiEndpoint('changeset', {
  get: {
    $query: {
      by: s.$string.optional,
      // unix ms - validated as uints here so a bad bound is a 400, never a requirement error
      from: s.$uint.optional,
      to: s.$uint.optional,
      ydoc: s.$boolean.optional,
      delta: s.$boolean.optional,
      attributions: s.$boolean.optional,
      // raw `k:v,k:v` string - parsed in the handler; the raw string is part of the cache key
      withCustomAttributions: s.$string.optional
    },
    handler: async req => {
      const { docRef, query } = req
      const includeYdoc = query.ydoc ?? false
      const includeDelta = query.delta ?? false
      // reads clamp, never refuse: the query's `from` is limited to the granted ray up front, and
      // the clamped bound is what the requirement, the cache key, and the compute args all see -
      // a bounded reader can never hit a fuller cached response. The check runs before any cache
      // read (a revoked reader must not reach `cachedGet`); without history it fails on `from`.
      // `?ydoc=`/`?delta=` render the document as it stood at `to` from a time-0 baseline - the
      // history ray bounds attributions, never the content snapshot - so they demand ydoc read
      const h = req.permissions?.history
      const from = math.max(query.from ?? 0, h ? h.from : 0)
      checkPermissions(req.permissions, createDocumentPermissions({ history: { from }, ...((includeYdoc || includeDelta) && { ydoc: '-r--' }) }))
      // lifted to the clamped `from`, so a `to` below the ray never inverts the window
      const to = math.max(query.to ?? number.MAX_SAFE_INTEGER, from)
      const by = query.by || ''
      const includeAttributions = query.attributions ?? false
      const withCustomAttributions = query.withCustomAttributions ? parseCustomAttributionsParam(query.withCustomAttributions) : null
      try {
        const cacheArgs = [String(from), String(to), by, String(includeYdoc), String(includeDelta), String(includeAttributions), query.withCustomAttributions || '']
        return encodedAny(await req.yhub.stream.cachedGet(docRef, 'changeset', cacheArgs, async () => {
          const { nongcDoc, contentmap: contentmapBin, tombstone } = await req.yhub.getDoc(docRef, { nongc: true, contentmap: true })
          if (tombstone != null) throw new DocDeletedError(docRef, tombstone)
          // the compute contract is nullable - unbounded is spelled `null` there, mapped back
          // here only, never in the cache key
          return req.yhub.computePool.changeset({ nongcDoc, contentmapBin, from: from === 0 ? null : from, to: to === number.MAX_SAFE_INTEGER ? null : to, by, withCustomAttributions, includeYdoc, includeDelta, includeAttributions }, { docRef })
        }))
      } catch (err) {
        // before the log: a deleted document is not a server error, and polling one should not
        // fill the error log. registerApi turns this into a 404.
        if (err instanceof DocDeletedError) throw err
        log.error({ err, docRef }, 'error handling changeset request')
        throw apiError(500, 'Failed to compute changeset')
      }
    }
  }
})

const activityEndpoint = createApiEndpoint('activity', {
  get: {
    $query: {
      by: s.$string.optional,
      // see changeset
      from: s.$uint.optional,
      to: s.$uint.optional,
      delta: s.$boolean.optional,
      ydoc: s.$boolean.optional,
      attributions: s.$boolean.optional,
      limit: s.$number.optional,
      order: s.$(['asc', 'desc']).optional,
      group: s.$boolean.optional,
      groupMaxGap: s.$number.optional,
      groupMaxDuration: s.$number.optional,
      // comma-separated userids exempt from grouping - the raw string is part of the cache key
      groupExclude: s.$string.optional,
      customAttributions: s.$boolean.optional,
      // raw `k:v,k:v` string - parsed in the handler; the raw string is part of the cache key
      withCustomAttributions: s.$string.optional,
      // base64-encoded Y.ContentIds - decoded in the handler; the raw string is part of the cache key
      contentIds: s.$string.optional
    },
    handler: async req => {
      const { docRef, query } = req
      const includeDelta = query.delta ?? false
      const includeYdoc = query.ydoc ?? false
      // `from` is limited to the granted ray before the check, the cache key, and the compute
      // args - see the changeset endpoint; rendered content demands ydoc read
      const h = req.permissions?.history
      const from = math.max(query.from ?? 0, h ? h.from : 0)
      checkPermissions(req.permissions, createDocumentPermissions({ history: { from }, ...((includeYdoc || includeDelta) && { ydoc: '-r--' }) }))
      const by = query.by || ''
      const to = math.max(query.to ?? number.MAX_SAFE_INTEGER, from) // see changeset
      const includeAttributions = query.attributions ?? false
      const limit = query.limit ?? number.MAX_SAFE_INTEGER
      const reverse = query.order === 'desc'
      const group = query.group ?? true
      const groupMaxGap = query.groupMaxGap ?? 1000
      const groupMaxDuration = query.groupMaxDuration ?? number.MAX_SAFE_INTEGER
      const groupExclude = query.groupExclude ? query.groupExclude.split(',') : []
      const withCustomAttributions = query.withCustomAttributions ? parseCustomAttributionsParam(query.withCustomAttributions) : null
      const includeCustomAttributions = query.customAttributions ?? false
      const contentIds = query.contentIds ? buffer.fromBase64(query.contentIds) : undefined
      try {
        const cacheArgs = [String(from), String(to), by, String(includeDelta), String(includeYdoc), String(includeAttributions), String(limit), reverse ? 'desc' : 'asc', String(group), String(groupMaxGap), String(groupMaxDuration), query.groupExclude || '', query.withCustomAttributions || '', String(includeCustomAttributions), query.contentIds || '']
        return encodedAny(await req.yhub.stream.cachedGet(docRef, 'activity', cacheArgs, async () => {
          const { contentmap: contentmapBin, nongcDoc, tombstone } = await req.yhub.getDoc(docRef, { nongc: true, contentmap: true })
          if (tombstone != null) throw new DocDeletedError(docRef, tombstone)
          return req.yhub.computePool.activity({ nongcDoc, contentmapBin, from, to, by, contentIds, withCustomAttributions, includeCustomAttributions, includeDelta, includeYdoc, includeAttributions, limit, reverse, group, groupMaxGap, groupMaxDuration, groupExclude }, { docRef })
        }))
      } catch (err) {
        // see the changeset endpoint
        if (err instanceof DocDeletedError) throw err
        log.error({ err, docRef }, 'error handling activity request')
        throw apiError(500, 'Failed to compute activity')
      }
    }
  }
})

/**
 * The built-in rest endpoints, registered by default ahead of `conf.server.api` (see registerApi).
 *
 * @type {Array<import('./types.js').ApiEndpoint>}
 */
export const builtinApi = [ydocEndpoint, rollbackEndpoint, pruneEndpoint, changesetEndpoint, activityEndpoint]
