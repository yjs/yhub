import * as Y from '@y/y'
import * as buffer from 'lib0/buffer'
import * as decoding from 'lib0/decoding'
import * as number from 'lib0/number'
import * as s from 'lib0/schema'
import { createApiEndpoint, DocDeletedError } from './types.js'
// benign import cycle with api.js - apiError is only referenced at request time, never during
// module evaluation
import { apiError, encodedAny } from './api.js'
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
      try {
        const { gcDoc, nongcDoc, awareness, tombstone } = await req.yhub.getDoc(req.room, { gc, nongc: !gc, awareness: req.query.awareness ?? false }, { gcOnMerge: false })
        if (tombstone != null) throw new DocDeletedError(req.room, tombstone)
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
        log.error({ err, room: req.room }, 'error handling ydoc request')
        throw apiError(500, 'Failed to retrieve document')
      }
    }
  },
  delete: {
    // deletion is gated separately from writing: an endpoint-level purpose would also change the
    // purpose that existing GET and PATCH callers are authorized against
    accessPurpose: 'delete',
    handler: async req => {
      // soft only over REST. `purpose` is advisory - an auth plugin that ignores it grants every
      // writer whatever the endpoint allows - so irreversible erasure stays programmatic
      // (`YHub.deleteDoc(room, { hard: true })`), like `recheckAuth`.
      const { deletedAt, hard, by } = await req.yhub.deleteDoc(req.room, { by: req.authInfo.userid })
      return { deletedAt, hard, by }
    }
  },
  patch: {
    $body: { update: s.$uint8Array.optional, awareness: s.$uint8Array.optional, customAttributions: s.$array($kv).optional },
    handler: async req => {
      const { update, awareness, customAttributions = [] } = req.body
      if (update == null && awareness == null) {
        throw apiError(400, 'Invalid request body')
      }
      if (update != null) {
        // Get current document state to diff against
        const { gcDoc, nongcDoc, tombstone } = await req.yhub.getDoc(req.room, { gc: true, nongc: false }, { gcOnMerge: false })
        if (tombstone != null) throw new DocDeletedError(req.room, tombstone)
        const currentDoc = gcDoc || nongcDoc || Y.encodeStateAsUpdate(new Y.Doc())
        const result = await req.yhub.computePool.patchYdoc({ update, currentDoc, userid: req.authInfo.userid, customAttributions }, { room: req.room })
        if (result != null) {
          await req.yhub.stream.addMessage(req.room, { type: 'ydoc:update:v1', contentmap: result.contentmap, update: result.update })
        }
      } else {
        // an awareness-only body never reads the document, so this is the only gate it passes -
        // writing awareness to a hard-deleted room would re-create the stream key the deletion
        // just cleared
        const tombstone = await req.yhub.persistence.retrieveTombstone(req.room)
        if (tombstone != null) throw new DocDeletedError(req.room, tombstone)
      }
      if (awareness != null) {
        await req.yhub.stream.addMessage(req.room, { type: 'awareness:v1', update: awareness })
      }
      return { success: true, message: 'Document updated' }
    }
  }
})

const $rollbackBody = s.$object({ from: s.$number.optional, to: s.$number.optional, by: s.$string.optional, contentIds: s.$uint8Array.optional, customAttributions: s.$array($kv).optional, withCustomAttributions: s.$array($kv).optional })

const rollbackEndpoint = createApiEndpoint('rollback', {
  post: {
    $body: $rollbackBody,
    handler: async req => {
      const { from, to, by, contentIds, customAttributions = [], withCustomAttributions = null } = req.body
      if (!from && !to && !by && !contentIds && (withCustomAttributions ?? []).length === 0) {
        throw apiError(400, 'Rollback requires at least one filter (from, to, by, contentIds, or withCustomAttributions)')
      }
      const { contentmap: contentmapBin, nongcDoc, tombstone } = await req.yhub.getDoc(req.room, { nongc: true, contentmap: true })
      if (tombstone != null) throw new DocDeletedError(req.room, tombstone)
      const { update, contentmap } = await req.yhub.computePool.rollback({ nongcDoc, contentmapBin, from, to, by, contentIds, withCustomAttributions, userid: req.authInfo.userid, customAttributions }, { room: req.room })
      if (update) {
        await req.yhub.stream.addMessage(req.room, { type: 'ydoc:update:v1', update, contentmap })
      }
      return { success: true, message: 'Rollback completed' }
    }
  }
})

const $pruneBody = s.$object({ from: s.$number.optional, to: s.$number.optional, by: s.$string.optional, contentIds: s.$uint8Array.optional, withCustomAttributions: s.$array($kv).optional })

const pruneEndpoint = createApiEndpoint('prune', {
  post: {
    $body: $pruneBody,
    handler: async req => {
      const { from, to, by, contentIds, withCustomAttributions = null } = req.body
      if (!from && !to && !by && !contentIds && (withCustomAttributions ?? []).length === 0) {
        throw apiError(400, 'Prune requires at least one filter (from, to, by, contentIds, or withCustomAttributions)')
      }
      await req.yhub.pruneDoc(req.room, { from, to, by, contentIds, withCustomAttributions })
      return { success: true, message: 'Prune completed' }
    }
  }
})

const changesetEndpoint = createApiEndpoint('changeset', {
  get: {
    $query: {
      by: s.$string.optional,
      from: s.$number.optional,
      to: s.$number.optional,
      ydoc: s.$boolean.optional,
      delta: s.$boolean.optional,
      attributions: s.$boolean.optional,
      // raw `k:v,k:v` string - parsed in the handler; the raw string is part of the cache key
      withCustomAttributions: s.$string.optional
    },
    handler: async req => {
      const { room, query } = req
      // `?? null`, not undefined - the compute contract is nullable and the cache key must
      // stringify absent bounds as 'null'
      const from = query.from ?? null
      const to = query.to ?? null
      const by = query.by || ''
      const includeYdoc = query.ydoc ?? false
      const includeDelta = query.delta ?? false
      const includeAttributions = query.attributions ?? false
      const withCustomAttributions = query.withCustomAttributions ? parseCustomAttributionsParam(query.withCustomAttributions) : null
      try {
        const cacheArgs = [String(from), String(to), by, String(includeYdoc), String(includeDelta), String(includeAttributions), query.withCustomAttributions || '']
        return encodedAny(await req.yhub.stream.cachedGet(room, 'changeset', cacheArgs, async () => {
          const { nongcDoc, contentmap: contentmapBin, tombstone } = await req.yhub.getDoc(room, { nongc: true, contentmap: true })
          if (tombstone != null) throw new DocDeletedError(room, tombstone)
          return req.yhub.computePool.changeset({ nongcDoc, contentmapBin, from, to, by, withCustomAttributions, includeYdoc, includeDelta, includeAttributions }, { room })
        }))
      } catch (err) {
        // before the log: a deleted document is not a server error, and polling one should not
        // fill the error log. registerApi turns this into a 404.
        if (err instanceof DocDeletedError) throw err
        log.error({ err, room }, 'error handling changeset request')
        throw apiError(500, 'Failed to compute changeset')
      }
    }
  }
})

const activityEndpoint = createApiEndpoint('activity', {
  get: {
    $query: {
      by: s.$string.optional,
      from: s.$number.optional,
      to: s.$number.optional,
      delta: s.$boolean.optional,
      ydoc: s.$boolean.optional,
      attributions: s.$boolean.optional,
      limit: s.$number.optional,
      order: s.$(['asc', 'desc']).optional,
      group: s.$boolean.optional,
      groupMaxGap: s.$number.optional,
      groupMaxDuration: s.$number.optional,
      customAttributions: s.$boolean.optional,
      // raw `k:v,k:v` string - parsed in the handler; the raw string is part of the cache key
      withCustomAttributions: s.$string.optional,
      // base64-encoded Y.ContentIds - decoded in the handler; the raw string is part of the cache key
      contentIds: s.$string.optional
    },
    handler: async req => {
      const { room, query } = req
      const by = query.by || ''
      const from = query.from ?? 0
      const to = query.to ?? number.MAX_SAFE_INTEGER
      const includeDelta = query.delta ?? false
      const includeYdoc = query.ydoc ?? false
      const includeAttributions = query.attributions ?? false
      const limit = query.limit ?? number.MAX_SAFE_INTEGER
      const reverse = query.order === 'desc'
      const group = query.group ?? true
      const groupMaxGap = query.groupMaxGap ?? 1000
      const groupMaxDuration = query.groupMaxDuration ?? number.MAX_SAFE_INTEGER
      const withCustomAttributions = query.withCustomAttributions ? parseCustomAttributionsParam(query.withCustomAttributions) : null
      const includeCustomAttributions = query.customAttributions ?? false
      const contentIds = query.contentIds ? buffer.fromBase64(query.contentIds) : undefined
      try {
        const cacheArgs = [String(from), String(to), by, String(includeDelta), String(includeYdoc), String(includeAttributions), String(limit), reverse ? 'desc' : 'asc', String(group), String(groupMaxGap), String(groupMaxDuration), query.withCustomAttributions || '', String(includeCustomAttributions), query.contentIds || '']
        return encodedAny(await req.yhub.stream.cachedGet(room, 'activity', cacheArgs, async () => {
          const { contentmap: contentmapBin, nongcDoc, tombstone } = await req.yhub.getDoc(room, { nongc: true, contentmap: true })
          if (tombstone != null) throw new DocDeletedError(room, tombstone)
          return req.yhub.computePool.activity({ nongcDoc, contentmapBin, from, to, by, contentIds, withCustomAttributions, includeCustomAttributions, includeDelta, includeYdoc, includeAttributions, limit, reverse, group, groupMaxGap, groupMaxDuration }, { room })
        }))
      } catch (err) {
        // see the changeset endpoint
        if (err instanceof DocDeletedError) throw err
        log.error({ err, room }, 'error handling activity request')
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
