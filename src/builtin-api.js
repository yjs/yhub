import * as Y from '@y/y'
import * as array from 'lib0/array'
import * as buffer from 'lib0/buffer'
import * as decoding from 'lib0/decoding'
import * as math from 'lib0/math'
import * as number from 'lib0/number'
import * as promise from 'lib0/promise'
import * as s from 'lib0/schema'
import * as sha256 from 'lib0/hash/sha256'
import { createApiEndpoint, DocDeletedError, $updateMessage, $versionCreate, $versionPut, $versionPatch } from './types.js'
import { createDocumentPermissions, hasPermissions } from './permissions.js'
import { redisClockToMs, encodeDocUpdatedMember } from './stream.js'
// benign import cycle with api.js - its exports are only referenced at request time, never during
// module evaluation
import { apiError, checkPermissions, encodedAny, runAuthHook, normalizeAuthorizeAnswer } from './api.js'
import { createContentMap } from './y-utils.js'
import { isComputeQueueFull } from './compute.js'
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
        // a deleted document is not a server error - registerApi turns this into a 404, and a full
        // compute queue into a 503
        if (err instanceof DocDeletedError || isComputeQueueFull(err)) throw err
        log.error({ err, docRef: req.docRef }, 'error handling ydoc request')
        throw apiError(500, 'Failed to retrieve document', { code: 'internal-error' })
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
        throw apiError(400, 'Invalid request body', { code: 'invalid-body' })
      }
      // presence without awareness `u` is dropped, not refused - same as a cursor sent over a
      // socket lacking the bit. Only the update leg is a hard requirement, checked before the
      // first stream write
      const awareness = req.body.awareness != null && hasPermissions(req.permissions, createDocumentPermissions({ awareness: '--u-' })) ? req.body.awareness : null
      if (update != null) checkPermissions(req.permissions, createDocumentPermissions({ ydoc: '--u-' }))
      // attributions carry the userid - permission first (403 names what is missing), identity second
      if (update != null && req.authInfo == null) throw apiError(401, 'writing the document requires authentication', { code: 'unauthenticated' })
      // neither leg reads the document, so this is the only gate either passes - writing to a
      // hard-deleted document would re-create the stream key the deletion just cleared
      const tombstone = await req.yhub.persistence.retrieveTombstone(req.docRef)
      if (tombstone != null) throw new DocDeletedError(req.docRef, tombstone)
      // appended as-is, like a socket update: getDoc accepts each id once, so a whole-document
      // body neither re-attributes nor overwrites what the server already holds. `> 3` is the
      // empty-update sentinel the ws path uses.
      if (update != null && update.byteLength > 3) {
        const contentmap = createContentMap(Y.createContentIdsFromUpdate(update), /** @type {string} */ (req.authInfo?.userid), customAttributions)
        await req.yhub.stream.addMessage(req.docRef, { type: 'ydoc:update:v1', contentmap, update })
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
        throw apiError(400, 'Rollback requires at least one filter (from, to, by, contentIds, or withCustomAttributions)', { code: 'missing-filter' })
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
        throw apiError(400, 'Prune requires at least one filter (from, to, by, contentIds, or withCustomAttributions)', { code: 'missing-filter' })
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
      diff: s.$boolean.optional,
      attributions: s.$boolean.optional,
      // raw `k:v,k:v` string - parsed in the handler; the raw string is part of the cache key
      withCustomAttributions: s.$string.optional
    },
    handler: async req => {
      const { docRef, query } = req
      const includeYdoc = query.ydoc ?? false
      const includeDelta = query.delta ?? false
      const includeDiff = query.diff ?? false
      // reads clamp, never refuse: the query's `from` is limited to the granted ray up front, and
      // the clamped bound is what the requirement, the cache key, and the compute args all see -
      // a bounded reader can never hit a fuller cached response. The check runs before any cache
      // read (a revoked reader must not reach `cachedGet`); without history it fails on `from`.
      // `?ydoc=`/`?delta=`/`?diff=` render the document as it stood at `to` from a time-0 baseline
      // - the history ray bounds attributions, never the content snapshot - so they demand ydoc read
      const h = req.permissions?.history
      const from = math.max(query.from ?? 0, h ? h.from : 0)
      checkPermissions(req.permissions, createDocumentPermissions({ history: { from }, ...((includeYdoc || includeDelta || includeDiff) && { ydoc: '-r--' }) }))
      // lifted to the clamped `from`, so a `to` below the ray never inverts the window
      const to = math.max(query.to ?? number.MAX_SAFE_INTEGER, from)
      const by = query.by || ''
      const includeAttributions = query.attributions ?? false
      const withCustomAttributions = query.withCustomAttributions ? parseCustomAttributionsParam(query.withCustomAttributions) : null
      try {
        const cacheArgs = [String(from), String(to), by, String(includeYdoc), String(includeDelta), String(includeDiff), String(includeAttributions), query.withCustomAttributions || '']
        return encodedAny(await req.yhub.stream.cachedGet(docRef, 'changeset', cacheArgs, async () => {
          const { nongcDoc, contentmap: contentmapBin, tombstone, lastClock } = await req.yhub.getDoc(docRef, { nongc: true, contentmap: true })
          if (tombstone != null) throw new DocDeletedError(docRef, tombstone)
          // the compute contract is nullable - unbounded is spelled `null` there, mapped back
          // here only, never in the cache key. `t` is the document's last-change clock, the
          // number the updated-documents listing reports - a poller stores it as its `from`.
          return req.yhub.computePool.changeset({ nongcDoc, contentmapBin, from: from === 0 ? null : from, to: to === number.MAX_SAFE_INTEGER ? null : to, by, withCustomAttributions, includeYdoc, includeDelta, includeDiff, includeAttributions, t: redisClockToMs(lastClock) }, { docRef })
        }))
      } catch (err) {
        // before the log: a deleted document is not a server error, and polling one should not fill
        // the error log. registerApi turns this into a 404, and a full compute queue into a 503.
        if (err instanceof DocDeletedError || isComputeQueueFull(err)) throw err
        log.error({ err, docRef }, 'error handling changeset request')
        throw apiError(500, 'Failed to compute changeset', { code: 'internal-error' })
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
      groupByUser: s.$boolean.optional,
      groupMaxGap: s.$number.optional,
      groupMaxDuration: s.$number.optional,
      // comma-separated userids exempt from grouping - the raw string is part of the cache key
      groupExclude: s.$string.optional,
      customAttributions: s.$boolean.optional,
      // raw `k:v,k:v` string - parsed in the handler; the raw string is part of the cache key
      withCustomAttributions: s.$string.optional,
      // base64-encoded Y.ContentIds - decoded in the handler; the raw string is part of the cache key
      contentIds: s.$string.optional,
      versions: s.$boolean.optional
    },
    handler: async req => {
      const { docRef, query } = req
      const includeDelta = query.delta ?? false
      const includeYdoc = query.ydoc ?? false
      // `from` is limited to the granted ray before the check, the cache key, and the compute
      // args - see the changeset endpoint; rendered content demands ydoc read
      const h = req.permissions?.history
      const from = math.max(query.from ?? 0, h ? h.from : 0)
      // named versions ride along whenever the caller may read them - an explicit `?versions=true`
      // without the grant is refused, never dropped
      const includeVersions = query.versions ?? hasPermissions(req.permissions, createDocumentPermissions({ history: { from, version: '-r--' } }))
      checkPermissions(req.permissions, createDocumentPermissions({ history: { from, ...(includeVersions && { version: '-r--' }) }, ...((includeYdoc || includeDelta) && { ydoc: '-r--' }) }))
      const by = query.by || ''
      const to = math.max(query.to ?? number.MAX_SAFE_INTEGER, from) // see changeset
      const includeAttributions = query.attributions ?? false
      const limit = query.limit ?? number.MAX_SAFE_INTEGER
      const reverse = query.order === 'desc'
      const group = query.group ?? true
      const groupByUser = query.groupByUser ?? true
      const groupMaxGap = query.groupMaxGap ?? 1000
      const groupMaxDuration = query.groupMaxDuration ?? number.MAX_SAFE_INTEGER
      const groupExclude = query.groupExclude ? query.groupExclude.split(',') : []
      const withCustomAttributions = query.withCustomAttributions ? parseCustomAttributionsParam(query.withCustomAttributions) : null
      const includeCustomAttributions = query.customAttributions ?? false
      const contentIds = query.contentIds ? buffer.fromBase64(query.contentIds) : undefined
      try {
        // read ahead of the cache: their digest keys the response, so a version write never meets
        // a stale cached response and needs no invalidation. Without versions this is the digest
        // of `[]` - and the response is that of a window without versions
        // every entry carries at most one version, so `limit` entries need at most the first `limit`
        // versions in reading order - plus one: descending, the version before them bounds where the
        // oldest kept entry starts
        const versions = includeVersions ? await req.yhub.persistence.retrieveVersions(docRef, { from, to, limit: limit > 0 && limit < number.MAX_SAFE_INTEGER ? math.floor(limit) + 1 : undefined, order: reverse ? 'desc' : 'asc' }) : []
        const cacheArgs = [String(from), String(to), by, String(includeDelta), String(includeYdoc), String(includeAttributions), String(limit), reverse ? 'desc' : 'asc', String(group), String(groupMaxGap), String(groupMaxDuration), query.groupExclude || '', query.withCustomAttributions || '', String(includeCustomAttributions), query.contentIds || '', String(groupByUser), buffer.toBase64(sha256.digest(buffer.encodeAny(versions)))]
        return encodedAny(await req.yhub.stream.cachedGet(docRef, 'activity', cacheArgs, async () => {
          const { contentmap: contentmapBin, nongcDoc, tombstone } = await req.yhub.getDoc(docRef, { nongc: true, contentmap: true })
          if (tombstone != null) throw new DocDeletedError(docRef, tombstone)
          return req.yhub.computePool.activity({ nongcDoc, contentmapBin, from, to, by, contentIds, withCustomAttributions, includeCustomAttributions, includeDelta, includeYdoc, includeAttributions, limit, reverse, group, groupByUser, groupMaxGap, groupMaxDuration, groupExclude, versions }, { docRef })
        }))
      } catch (err) {
        // see the changeset endpoint
        if (err instanceof DocDeletedError || isComputeQueueFull(err)) throw err
        log.error({ err, docRef }, 'error handling activity request')
        throw apiError(500, 'Failed to compute activity', { code: 'internal-error' })
      }
    }
  }
})

/**
 * The documents of `org` changed after `since`, oldest first, as `{ docid, branch, t }` - `t`
 * being the ms of the stream clock of the document's last change (an update, a prune or its
 * deletion), the number the changeset response carries as `t` too. A poller stores `next` as its
 * cursor and `t` per document, and fetches a listed document when its `t` moved. The protocol is
 * documented in API.md ("Updated documents"): `since` is exclusive, a page never splits a
 * millisecond (so `limit` is soft, as in the global listing below), `next === since` means caught
 * up (a page can be empty while `next` advanced: every document on it was filtered out), a
 * document may be listed twice across pages but is never missed.
 *
 * Two sources - the redis index of live streams and the persisted rows - are read concurrently
 * with the page's `limit` each and merged. A source that returned fewer rows than `limit` is
 * complete; one that returned `limit` rows is complete below the last clock it returned. So the
 * merged list is complete below the clock at the cut, and the millisecond *at* the cut is re-read
 * whole whenever the page is full. Deduplication happens after that: a document present in both
 * sources (the redis entry at its last update, a postgres row at the same or a later clock) must
 * not move the cut.
 *
 * The page also ends before `now`, the redis time read right after the index. That millisecond is
 * still open: a document listed in it could change again at the same `t`, which a poller comparing
 * `t` would not fetch, and a write landing in it would be behind a `next` that named it.
 */
const updatedEndpoint = createApiEndpoint('updated', {
  scope: 'org',
  get: {
    $query: { since: s.$uint.optional, limit: s.$uint.optional },
    handler: async req => {
      const { yhub, org, authInfo } = req
      const since = req.query.since ?? 0
      const limit = math.max(req.query.limit ?? 10000, 1)
      /**
       * @param {number} from
       * @param {number} [to]
       * @param {number} [limit]
       */
      const read = async (from, to, limit) => {
        const [{ docs: live, now }, persisted] = await promise.all([yhub.stream.getUpdatedDocs(org, { from, to, limit }), yhub.persistence.retrieveUpdatedDocs(org, { from, to, limit })])
        return { docs: persisted.concat(live).sort((a, b) => a.t - b.t), now }
      }
      let { docs, now } = await read(since + 1, undefined, limit)
      if (docs.length >= limit && docs[limit - 1].t < now) {
        // a full page: either source may have cut the millisecond at its end short, so that
        // millisecond is re-read whole and the page ends at a boundary. A cut at or after `now`
        // is dropped below anyway.
        const cut = docs[limit - 1].t
        docs = docs.filter(d => d.t < cut).concat((await read(cut, cut)).docs)
      }
      // the millisecond of the read is still open
      docs = docs.filter(d => d.t < now)
      const next = docs.length > 0 ? array.last(docs).t : since
      /**
       * @type {Map<string, { docid: string, branch: string, t: number }>}
       */
      const page = new Map()
      docs.forEach(d => page.set(encodeDocUpdatedMember({ org, docid: d.docid, branch: d.branch }), d))
      const auth = /** @type {import('./types.js').AuthPlugin<any>} */ (yhub.conf.server?.auth)
      const readable = createDocumentPermissions({ ydoc: '-r--' })
      /**
       * @type {Array<{ docid: string, branch: string, t: number }>}
       */
      const visible = []
      // one authorize call per listed document, 16 in flight. A failing plugin fails the request
      // (503 - see runAuthHook) rather than dropping the document: `next` would move past it.
      const candidates = array.from(page.values()).sort((a, b) => a.t - b.t)
      for (let i = 0; i < candidates.length && !req.aborted; i += 16) {
        const chunk = candidates.slice(i, i + 16)
        const answers = await promise.all(chunk.map(d => runAuthHook(yhub, 'authorize', () => auth.authorize('document', { org, docid: d.docid, branch: d.branch }, authInfo))))
        answers.forEach((answer, j) => { hasPermissions(normalizeAuthorizeAnswer('document', answer), readable) && visible.push(chunk[j]) })
      }
      return { docs: visible, next }
    }
  }
})

/**
 * The orgs the index learned a change of after `since`, oldest first, as `{ org, t }` - `t` being
 * the org's last-change clock (the max over its documents' `t` in the org-level listing above), the
 * trigger to page `GET /updated/{org}` with a per-org cursor. `since` and `next` are learn clocks,
 * not change clocks (see `encodeOrgUpdatedKey`): a change that reached the index late - another
 * process's batch, a crash repaired by the worker - is stamped when it arrives, so it is listed
 * after every cursor that came before it. Paging as in the org-level listing - `since` is exclusive,
 * `next === since` means caught up, a page never splits a millisecond (so `limit` is soft) -
 * except that it lists every org learned so far, while `next` never names the millisecond the
 * page was read in (see `Stream.getUpdatedOrgs`). The default limit is large (10000): every restamp
 * moves an org to the end, so a consumer that reads small pages and falls behind never reaches the
 * orgs that change more often than it lags (API.md, "Updated orgs").
 *
 * The global `endpoint.updated` grant gates the route, and the listing covers only the orgs of the
 * caller's global `orgs` facet - every org for `'*'`. Without `orgs` the request is refused with the
 * missing-permission 403 - without `required`, since any list satisfies the route. One
 * permission answer for the whole page, no per-org `authorize` call.
 */
const updatedOrgsEndpoint = createApiEndpoint('updated', {
  scope: 'global',
  get: {
    $query: { since: s.$uint.optional, limit: s.$uint.optional },
    handler: async req => {
      const since = req.query.since ?? 0
      const limit = math.max(req.query.limit ?? 10000, 1)
      const access = req.permissions?.orgs ?? false
      // no `required`: any list satisfies the route, which a permission object cannot express
      if (access === false) throw apiError(403, "requires the global orgs permission: '*' or a list of orgs", { code: 'missing-permission' })
      return req.yhub.stream.getUpdatedOrgs({ since, limit, orgs: access })
    }
  }
})

/**
 * The version endpoint never reads the document, so this is its deletion gate. A soft deletion
 * keeps the named versions for a restore, a hard one erases them with the content.
 *
 * @param {import('./index.js').YHub} yhub
 * @param {import('./types.js').DocRef} docRef
 */
const refuseDeleted = async (yhub, docRef) => {
  const tombstone = await yhub.persistence.retrieveTombstone(docRef)
  if (tombstone != null) throw new DocDeletedError(docRef, tombstone)
}

/**
 * The client's `custom` data of a named version, lib0-any encoded. The client's part of a version
 * - its name and custom data - rides along in activity responses, so its size is bounded
 * (`server.maxVersionSize`).
 *
 * @param {import('./index.js').YHub} yhub
 * @param {{ name: string, custom?: any }} version
 */
const encodeVersionCustom = (yhub, { name, custom }) => {
  const encoded = /** @type {Uint8Array<ArrayBuffer>} */ (buffer.encodeAny(custom ?? null))
  const max = /** @type {number} */ (yhub.conf.server?.maxVersionSize)
  if (name.length + encoded.byteLength > max) throw apiError(413, `name characters and custom bytes of a named version exceed ${max}`, { code: 'version-too-large' })
  return encoded
}

/**
 * `history.publish` at `t`. It sets a named version's `published` flag - a flag sent without it is
 * ignored, like presence without awareness `u` on PATCH /ydoc - and it writes published versions,
 * which are frozen for everyone else.
 *
 * @param {number} t
 */
const publishing = t => createDocumentPermissions({ history: { from: t, publish: true } })

// named versions: `t` is a point of the document's history - an `activity.to` - and the ray must
// contain it. Reads clamp, mutations refuse (see rollback). Writes are attributed to the caller.
const versionEndpoint = createApiEndpoint('version', {
  get: {
    $query: { from: s.$uint.optional, to: s.$uint.optional },
    handler: async req => {
      const { docRef, query } = req
      const h = req.permissions?.history
      const from = math.max(query.from ?? 0, h ? h.from : 0)
      checkPermissions(req.permissions, createDocumentPermissions({ history: { from, version: '-r--' } }))
      await refuseDeleted(req.yhub, docRef)
      return { versions: await req.yhub.persistence.retrieveVersions(docRef, { from, to: math.max(query.to ?? number.MAX_SAFE_INTEGER, from) }) }
    }
  },
  post: {
    $body: $versionCreate,
    handler: async req => {
      const { docRef, body } = req
      // without `t` the point is only known after reading the history - nothing is read before
      // the caller may create versions at all
      checkPermissions(req.permissions, createDocumentPermissions({ history: { from: body.t ?? number.MAX_SAFE_INTEGER, version: 'c---' } }))
      if (req.authInfo == null) throw apiError(401, 'writing a named version requires authentication', { code: 'unauthenticated' })
      const custom = encodeVersionCustom(req.yhub, body)
      const { lastClock, tombstone } = await req.yhub.persistence.retrieveAssets(docRef, {})
      if (tombstone != null) throw new DocDeletedError(docRef, tombstone)
      // a version names a point of the existing history, never the server's clock: omitted, it is
      // the last update on the stream, else the last persisted one. '0' - no history - names nothing.
      let t = body.t
      if (t == null) {
        const [streamed] = await req.yhub.stream.getMessages([{ docRef, clock: '0' }])
        const lastUpdate = array.last(streamed?.messages.filter(m => $updateMessage.check(m)) ?? [])
        t = redisClockToMs(lastUpdate?.redisClock ?? lastClock)
      }
      if (t === 0) throw apiError(400, 'no point of the document history to name', { code: 'no-history' })
      checkPermissions(req.permissions, createDocumentPermissions({ history: { from: t, version: 'c---' } }))
      const published = hasPermissions(req.permissions, publishing(t)) ? body.published : undefined
      const version = await req.yhub.persistence.storeVersion(docRef, { t, name: body.name, custom, published, at: await req.yhub.stream.getTime(), by: req.authInfo.userid })
      // `null` is also a hard deletion racing this request - too rare to tell apart
      if (version == null) throw apiError(409, `a named version exists at ${t}`, { code: 'version-exists' })
      return version
    }
  },
  put: {
    $body: $versionPut,
    handler: async req => {
      const { docRef, body } = req
      // creates or replaces - whichever happens, both are required
      checkPermissions(req.permissions, createDocumentPermissions({ history: { from: body.t, version: 'c-u-' } }))
      if (req.authInfo == null) throw apiError(401, 'writing a named version requires authentication', { code: 'unauthenticated' })
      const custom = encodeVersionCustom(req.yhub, body)
      await refuseDeleted(req.yhub, docRef)
      const publisher = hasPermissions(req.permissions, publishing(body.t))
      const version = await req.yhub.persistence.storeVersion(docRef, { t: body.t, name: body.name, custom, published: publisher ? body.published : undefined, at: await req.yhub.stream.getTime(), by: req.authInfo.userid }, { replace: true, mayWritePublished: publisher })
      if (version == null) {
        // a published version the caller may not write - or a hard deletion racing this request
        const [current] = await req.yhub.persistence.retrieveVersions(docRef, { from: body.t, to: body.t })
        if (current != null) checkPermissions(req.permissions, publishing(body.t))
        throw apiError(404, 'document was deleted', { code: 'doc-deleted' })
      }
      return version
    }
  },
  patch: {
    $body: $versionPatch,
    handler: async req => {
      const { docRef, body } = req
      checkPermissions(req.permissions, createDocumentPermissions({ history: { from: body.t, version: '--u-' } }))
      if (req.authInfo == null) throw apiError(401, 'writing a named version requires authentication', { code: 'unauthenticated' })
      const custom = encodeVersionCustom(req.yhub, body)
      await refuseDeleted(req.yhub, docRef)
      const publisher = hasPermissions(req.permissions, publishing(body.t))
      const { updated, version } = await req.yhub.persistence.updateVersion(docRef, { t: body.t, name: body.name, custom, published: publisher ? body.published : undefined, at: await req.yhub.stream.getTime(), by: req.authInfo.userid, updatedAt: body.updatedAt }, { mayWritePublished: publisher })
      if (version == null) throw apiError(404, `no named version at ${body.t}`, { code: 'version-not-found' })
      if (!updated) {
        // the state the caller read, but published - frozen for callers that may not publish
        if (version.updatedAt === body.updatedAt) checkPermissions(req.permissions, publishing(body.t))
        // written since the caller read it - the current version lets it merge and retry
        throw apiError(409, `the named version at ${body.t} changed since ${body.updatedAt}`, { code: 'version-conflict', version })
      }
      return version
    }
  },
  delete: {
    $query: { t: s.$uint, updatedAt: s.$uint },
    handler: async req => {
      const { docRef, query: { t, updatedAt } } = req
      checkPermissions(req.permissions, createDocumentPermissions({ history: { from: t, version: '---d' } }))
      await refuseDeleted(req.yhub, docRef)
      const { deleted, version } = await req.yhub.persistence.deleteVersion(docRef, { t, updatedAt }, { mayWritePublished: hasPermissions(req.permissions, publishing(t)) })
      // a version that is gone already is what the caller asked for: deleting is idempotent
      if (!deleted && version != null) {
        // see PATCH: frozen, or written since the caller read it
        if (version.updatedAt === updatedAt) checkPermissions(req.permissions, publishing(t))
        throw apiError(409, `the named version at ${t} changed since ${updatedAt}`, { code: 'version-conflict', version })
      }
    }
  }
})

/**
 * The built-in rest endpoints, registered by default ahead of `conf.server.api` (see registerApi).
 *
 * @type {Array<import('./types.js').ApiEndpoint>}
 */
export const builtinApi = [ydocEndpoint, rollbackEndpoint, pruneEndpoint, changesetEndpoint, activityEndpoint, versionEndpoint, updatedEndpoint, updatedOrgsEndpoint]
