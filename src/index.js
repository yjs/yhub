import * as promise from 'lib0/promise'
import * as strm from './stream.js'
import * as p from './persistence.js'
import * as t from './types.js'
import * as Y from '@y/y'
import * as object from 'lib0/object'
import * as array from 'lib0/array'
import * as math from 'lib0/math'
import * as protocol from './protocol.js'
import * as server from './server.js'
import { createComputePool } from './compute.js'
import { agentTask } from './agents.js'
import { logger } from './logger.js'
import * as time from 'lib0/time'

export { createAuthPlugin, createApiEndpoint, DocDeletedError } from './types.js'
export { apiError, encodedAny } from './api.js'
export { wsCloseAuthRevoked, wsCloseDocDeleted } from './server.js'
export { logger } from './logger.js'

const log = logger.child({ module: 'worker' })

/**
 * Erase the content of a deleted `room`: its rows in `yhub_ydoc_v1` together with the assets they
 * reference, and any quarantined backlog in redis. Goes through the same `deleteReferences` path
 * compaction uses, so a row is always dropped before the asset it points at - the reverse would
 * leave references dangling, which read back as silently missing content.
 *
 * Deliberately not part of the public api. Erasing content is only safe once `hard` is set, which
 * is what arms the barrier in `Persistence.store` against a compaction that is still in flight;
 * reachable on its own it would invite purging a merely soft-deleted room, whose rows a straggler
 * compaction could then write straight back. `deleteDoc(room, { hard: true })` is the way in, and
 * it is also how a retention task erases what it swept up with `getTombstones`.
 *
 * The returned tombstone carries the `purgedAt` this stamped. That records that the rows are gone
 * and the assets are handed to the plugins for deletion, not that every byte has already left the
 * store: a plugin may defer (`S3PersistenceV1` does, to let concurrent readers finish). What an
 * interrupted purge leaves behind is an orphaned object, never a reference to a missing one.
 *
 * @param {YHub} yhub
 * @param {t.Room} room
 * @returns {Promise<t.Tombstone>}
 */
const purgeDoc = async (yhub, room) => {
  // different stores, no ordering between them
  const [, , purgedAt] = await promise.all([
    yhub.persistence.purgeDoc(room),
    yhub.stream.deleteQuarantineStreams(room),
    yhub.stream.getTime()
  ])
  return yhub.persistence.storeTombstonePurged(room, purgedAt)
}

/**
 * @template {t.YHubConfig} [Conf=t.YHubConfig]
 */
export class YHub {
  /**
   * @param {Conf} conf
   * @param {strm.Stream} str
   * @param {p.Persistence} pers
   */
  constructor (conf, str, pers) {
    if (conf.server) {
      conf.server.maxDocSize = 500 * 1024 * 1024
    }
    this.conf = conf
    this.stream = str
    this.persistence = pers
    /**
     * @type {Conf['server'] extends null ? null : server.YHubServer}
     */
    this.server = /** @type {any} */ (null)
    this.computePool = createComputePool({ poolSize: conf.computePoolSize, taskTimeout: conf.maxTaskDuration })
    this._workerCtx = {
      shouldRun: false
    }
  }

  async startWorker () {
    if (this._workerCtx.shouldRun || this.conf.worker == null) return
    // create new worker context
    const ctx = (this._workerCtx = {
      shouldRun: true
    })
    /**
     * The tasks we are currently computing. Their lease is renewed until they are done, so they
     * are neither reclaimed by another worker nor handed back to us by `claimTasks`.
     *
     * @type {Map<string, { started: number, room: t.Room }>}
     */
    const inflight = new Map()
    // taskDebounce is the granularity at which work becomes claimable - a task enqueued now (the
    // successor a completing compaction leaves behind) can only be claimed that much later. Poll
    // a few times per debounce so that just missing the window costs a fraction of it, not a
    // whole poll interval.
    const pollInterval = math.min(1000, math.floor(this.stream.taskDebounce / 3))
    this._renewLeases(ctx, inflight).catch(err => log.error({ err }, 'lease renewal failed'))
    while (ctx.shouldRun) {
      try {
        const free = this.conf.worker.taskConcurrency - inflight.size
        // `claimTasks` hands us back our own in-flight tasks once they idled for longer than
        // taskDebounce (a renewal that came too late). Don't run them a second time.
        const tasks = (free > 0 ? await this.stream.claimTasks(free) : []).filter(task => !inflight.has(task.redisClock))
        tasks.length && log.info({ taskCount: tasks.length }, 'picked up tasks')
        tasks.forEach(task => {
          const run = { started: time.getUnixTime(), room: task.room }
          inflight.set(task.redisClock, run)
          this._runTask(task)
            .catch(err => log.error({ err, room: task.room }, 'error processing task'))
            // an abandoned run must not delete the entry of the run that replaced it
            .finally(() => inflight.get(task.redisClock) === run && inflight.delete(task.redisClock))
        })
        if (tasks.length === 0) {
          await promise.wait(pollInterval)
        }
      } catch (err) {
        log.error({ err }, 'error claiming tasks')
        await promise.wait(3000)
      }
    }
  }

  /**
   * Keep the lease on the tasks we are computing alive. Runs next to the claim loop so that a
   * slow `claimTasks` or its error backoff can't starve renewals.
   *
   * @param {{ shouldRun: boolean }} ctx
   * @param {Map<string, { started: number, room: t.Room }>} inflight
   */
  async _renewLeases (ctx, inflight) {
    const interval = math.min(1000, math.floor(this.stream.taskDebounce / 3))
    while (ctx.shouldRun) {
      await promise.wait(interval)
      if (inflight.size === 0) continue
      const now = time.getUnixTime()
      // the compute pool kills a compute task that overruns, which rejects it. Getting here means
      // the task is stuck where we can't kill it - waiting for a wedged s3 or postgres socket, or
      // queued behind other compute tasks - so all we can do is let go: stop renewing, and the
      // room is reclaimed by another worker after redis.taskDebounce.
      array.from(inflight.entries()).forEach(([taskId, run]) => {
        if (now - run.started > this.computePool.taskTimeout) {
          log.error({ room: run.room, taskDurationMs: now - run.started }, 'task exceeded maxTaskDuration outside of compute, abandoning it')
          inflight.delete(taskId)
        }
      })
      const taskIds = array.from(inflight.keys())
      if (taskIds.length === 0) continue
      try {
        // the reply lists the ids we still hold, but it can't tell a lost lease from a task that
        // completed during the round trip - so there is nothing useful to report from it
        await this.stream.renewTasks(taskIds)
      } catch (err) {
        log.error({ err }, 'error renewing task leases')
      }
    }
  }

  /**
   * @param {t.Task & { redisClock: string }} task
   */
  async _runTask (task) {
    if (task.type !== 'compact') return
    const taskLog = log.child({ taskType: task.type, room: task.room })
    /**
     * @type {Error | null}
     */
    let taskErr = null
    const taskTs = time.getUnixTime()
    try {
      this.conf.worker?.events?.taskStart?.({ room: task.room, timestamp: taskTs })
      taskLog.info('task started')
      // cheap pre-check: pull the stream and the persisted clock (no ydoc blobs, no S3) so
      // we can skip the expensive fetch+merge when there is nothing new to persist. only
      // update/prune messages change the document and advance lastUpdateClock.
      const [cachedMessages, persisted] = await promise.all([
        this.stream.getMessages([{ room: task.room, clock: '0' }]).then(ms => ms[0] || { messages: [], lastClock: '0' }),
        this.persistence.retrieveDoc(task.room, {})
      ])
      const lastUpdateClock = cachedMessages.messages.reduce(
        (clk, m) => (m.type === 'ydoc:update:v1' || m.type === 'prune:v1') ? strm.maxRedisClock(clk, m.redisClock) : clk,
        persisted.lastClock
      )
      // a hard-deleted room is never persisted again - its content is thrown away and its
      // stream trimmed down to nothing. `store` refuses it regardless (that guard is what
      // closes the race against a merge that is already running); skipping here only
      // avoids doing the work. A soft-deleted room compacts normally, so whatever is on
      // the stream is persisted before it is trimmed away.
      if (persisted.tombstone?.hard || !strm.isSmallerRedisClock(persisted.lastClock, lastUpdateClock)) {
        taskLog.debug('nothing to compact, trimming only')
        // a hard-deleted room drains in this one pass: with maxAgeMs 0 the lua trims
        // everything, finds the stream empty, DELs the key and the task is already acked.
        // Safe because a task is only claimed after taskDebounce, long after every
        // subscriber has seen the kick that was added when the document was deleted.
        await this.stream.trimMessages(task.room, strm.maxRedisClock(persisted.lastClock, cachedMessages.lastClock), persisted.tombstone?.hard ? 0 : this.stream.minMessageLifetime, task.redisClock)
        taskLog.info('task completed (trim only)')
        return
      }
      // there is new content: fetch + merge the ydoc, reusing the stream we already pulled
      const d = await this.getDoc(task.room, { gc: true, nongc: true, contentmap: true, contentids: true, references: true }, { cachedMessages })
      // re-check what the pre-check established, now that the slow merge is done: another worker
      // may have persisted this exact clock while we were computing. `store` would then be
      // skipped by ON CONFLICT while `deleteReferences` still deletes that row - the only copy of
      // the document. There is nothing new to write in that case, so only trim.
      if (!strm.isSmallerRedisClock(d.lastPersistedClock, d.lastClock)) {
        taskLog.warn('another worker persisted this room while we were computing, trimming only')
        await this.stream.trimMessages(task.room, d.lastClock, this.stream.minMessageLifetime, task.redisClock)
        return
      }
      this.conf.worker?.events?.docUpdate?.(object.assign({}, d, { references: null, room: task.room }))
      await this.persistence.store(task.room, d)
      await promise.all([
        this.persistence.deleteReferences(d.references),
        this.stream.trimMessages(task.room, d.lastClock, this.stream.minMessageLifetime, task.redisClock)
      ])
      taskLog.info({ gcDocSize: d.gcDoc?.byteLength, nongcDocSize: d.nongcDoc?.byteLength, refsDeleted: d.references?.length ?? 0 }, 'task completed')
    } catch (e) {
      taskErr = /** @type {Error} */ (e)
      throw e
    } finally {
      this.conf.worker?.events?.taskComplete?.({ room: task.room, duration: time.getUnixTime() - taskTs, error: taskErr })
    }
  }

  /**
   * Stop claiming tasks and stop renewing the leases of the tasks that are still running - they
   * go stale and are reclaimed by another worker after `redis.taskDebounce`.
   */
  stopWorker () {
    this._workerCtx.shouldRun = false
  }

  /**
   * @template {{ gc?: boolean, nongc?: boolean, contentmap?: boolean, references?: boolean, contentids?: boolean, awareness?: boolean }} Include
   * @param {t.Room} room
   * @param {Include} includeContent
   * @param {object} opts
   * @param {boolean} [opts.gcOnMerge] whether to gc when merging updates. (default: true)
   * @param {{ messages: Array<t.Message & { redisClock: string }>, lastClock: string }} [opts.cachedMessages] pre-fetched stream messages, to avoid pulling the redis stream again
   * @return {Promise<t.DocTable<Include>>}
   */
  async getDoc (room, includeContent, { gcOnMerge = true, cachedMessages: prefetched } = {}) {
    const [persistedDoc, cachedMessages] = await promise.all([
      this.persistence.retrieveDoc(room, object.assign({}, includeContent, { contentids: /** @type {const} */ (true) })),
      prefetched ?? this.stream.getMessages([{ room, clock: '0' }]).then(ms => ms[0] || { messages: [], lastClock: '0' })
    ])
    const gcDoc = persistedDoc.gcDoc
    const nongcDoc = persistedDoc.nongcDoc
    const contentmap = persistedDoc.contentmap?.map(Y.decodeContentMap)
    const contentids = /** @type {Array<Uint8Array>} */ (persistedDoc.contentids).map(Y.decodeContentIds)
    const references = persistedDoc.references
    const awareness = /** @type {Include['awareness'] extends true ? Uint8Array<ArrayBuffer> : null} */ (includeContent.awareness ? protocol.mergeAwarenessUpdates(cachedMessages.messages.filter(m => m.type === 'awareness:v1').map(m => m.update)) : null)
    const lastClock = strm.maxRedisClock(persistedDoc.lastClock, cachedMessages.lastClock)
    const mergedContentIds = Y.mergeContentIds(contentids)
    cachedMessages.messages.forEach(m => {
      // only add update messages that are newer that what we currently know
      if (t.$updateMessage.check(m) && strm.isSmallerRedisClock(persistedDoc.lastClock, m.redisClock)) {
        // attributions can only be assigned once. Filter out "known" attributions
        const mcontentmap = Y.excludeContentMap(Y.decodeContentMap(m.contentmap), mergedContentIds)
        const mcontentids = Y.createContentIdsFromContentMap(mcontentmap)
        Y.insertIntoIdSet(mergedContentIds.inserts, mcontentids.inserts)
        Y.insertIntoIdSet(mergedContentIds.deletes, mcontentids.deletes)
        gcDoc?.push(m.update)
        nongcDoc?.push(m.update)
        contentmap?.push(mcontentmap)
        contentids.push(mcontentids)
      }
    })
    // prune directives garbage-collect churned history: drop the referenced IdSet from the
    // nongc doc, the contentmap, and the contentids. Applied unconditionally (idempotent).
    const pruneMsgs = cachedMessages.messages.filter(m => t.$pruneMessage.check(m))
    const pruneSet = pruneMsgs.length > 0 ? Y.mergeIdSets(pruneMsgs.map(m => Y.decodeIdSet(m.prune))) : null
    const mergedContentmap = contentmap != null ? Y.mergeContentMaps(contentmap) : null
    const mergedCids = Y.mergeContentIds(contentids)
    if (pruneSet != null) {
      if (mergedContentmap != null) {
        mergedContentmap.inserts = Y.diffIdMap(mergedContentmap.inserts, pruneSet)
        mergedContentmap.deletes = Y.diffIdMap(mergedContentmap.deletes, pruneSet)
      }
      mergedCids.inserts = Y.diffIdSet(mergedCids.inserts, pruneSet)
      mergedCids.deletes = Y.diffIdSet(mergedCids.deletes, pruneSet)
    }
    const pruneBin = pruneSet != null ? Y.encodeIdSet(pruneSet) : undefined
    return {
      gcDoc: /** @type {Include['gc'] extends true ? Uint8Array<ArrayBuffer> : null} */ (gcDoc ? await this.computePool.mergeUpdates(gcOnMerge, gcDoc, { room }) : null),
      nongcDoc: /** @type {Include['nongc'] extends true ? Uint8Array<ArrayBuffer> : null} */ (nongcDoc ? await this.computePool.mergeUpdates(false, nongcDoc, { room }, pruneBin) : null),
      contentmap: /** @type {Include['contentmap'] extends true ? Uint8Array<ArrayBuffer> : null} */ (mergedContentmap != null ? Y.encodeContentMap(mergedContentmap) : null),
      contentids: /** @type {Include['contentids'] extends true ? Uint8Array<ArrayBuffer> : null} */ (includeContent.contentids === true ? Y.encodeContentIds(mergedCids) : null),
      lastClock,
      lastPersistedClock: persistedDoc.lastClock,
      tombstone: persistedDoc.tombstone,
      references,
      awareness,
      authChecks: cachedMessages.messages.filter(m => t.$authCheckMessage.check(m))
    }
  }

  /**
   * Permanently prunes churned history: content that was both inserted and deleted within the
   * filtered range is garbage-collected and removed from the activity history. This is
   * irreversible. The prune is distributed as a directive on the redis stream and baked into
   * persistence the next time the document is compacted.
   *
   * @param {t.Room} room
   * @param {object} filters
   * @param {number} [filters.from]
   * @param {number} [filters.to]
   * @param {string} [filters.by]
   * @param {Uint8Array<ArrayBuffer>} [filters.contentIds]
   * @param {Array<{k: string, v: string}>|null} [filters.withCustomAttributions]
   * @returns {Promise<void>}
   */
  async pruneDoc (room, filters) {
    const { contentmap, tombstone } = await this.getDoc(room, { contentmap: true })
    if (tombstone != null) throw new t.DocDeletedError(room, tombstone)
    if (contentmap == null) return
    const prune = await this.computePool.computePruneSet({ contentmapBin: contentmap, ...filters }, { room })
    if (prune != null) {
      await this.stream.addMessage(room, { type: 'prune:v1', prune })
    }
  }

  /**
   * Force a permission re-check for the websocket connections of `room`, distributed via the
   * redis stream to all servers. Each matching connection re-evaluates
   * `auth.getAccessType(authInfo, room, null)` and is disconnected (close code 4401
   * 'permission revoked') when its access type changed — the client then reconnects,
   * re-authenticates, and resyncs at its new access level. A failing auth plugin fails closed
   * with the transient close code 1013 ('auth recheck failed'), so clients reconnect once the
   * auth backend recovers. With `forceDisconnect: true`, matching connections are disconnected
   * without re-checking. Note that a disconnect cannot keep users out: reconnects are
   * re-authenticated at upgrade, so revoke access in the auth plugin's authority first.
   *
   * `users` is an array of matchers; `null` matches every connection in the room. A string
   * matcher matches connections with that `userid`. A plain-object matcher matches a
   * connection when each of its top-level properties deep-equals the corresponding property
   * of the connection's authInfo (the authInfo may have additional properties) — e.g.
   * `{ userid: 'X' }` matches the authInfo `{ userid: 'X', name: 'Kevin' }`.
   *
   * @param {t.Room} room
   * @param {object} opts
   * @param {Array<string|Object<string,any>>?} [opts.users]
   * @param {boolean} [opts.forceDisconnect]
   * @returns {Promise<void>}
   */
  async recheckAuth (room, { users = null, forceDisconnect = false } = {}) {
    await this.stream.addMessage(room, { type: 'auth:check:v1', users, forceDisconnect })
  }

  /**
   * Delete `room`.
   *
   * A soft deletion (the default) only records that the document is gone: reads report it as
   * deleted and every endpoint answers 404, connected clients are disconnected, but its rows and
   * assets are left alone and compaction keeps running - so nothing that was already on the
   * stream is lost before it is trimmed, and `restoreDoc` brings the document back intact.
   * Erasing the content later is a retention task's job: sweep `getTombstones` and hard-delete
   * what is due.
   *
   * A hard deletion additionally clears the stream and erases every row and asset right away,
   * and cannot be undone. Compaction never persists a hard-deleted room again.
   *
   * Tombstone is per branch - deleting a document with all of its branches means deleting each of
   * them.
   *
   * Idempotent: a repeated deletion keeps the original `deletedAt` (a retry must not
   * extend a retention window), and a soft deletion can be upgraded to a hard one, never the
   * reverse. Re-running a hard deletion re-runs the purge, which is how a compaction that was
   * still in flight the first time gets cleaned up.
   *
   * @param {t.Room} room
   * @param {object} [opts]
   * @param {boolean} [opts.hard] erase the content immediately and irreversibly. (default: false)
   * @param {string|null} [opts.by] userid recorded as the deleting user
   * @returns {Promise<t.Tombstone>}
   */
  async deleteDoc (room, { hard = false, by = null } = {}) {
    // postgres first: it is the durable record, and every step after it is idempotent and
    // re-derivable from it. The other order would let a crash leave a kick that is trimmed away
    // minutes later, silently undeleting the document with nothing left to heal from.
    const tombstone = await this.persistence.storeTombstone(room, { deletedAt: await this.stream.getTime(), hard, by })
    // both only have to happen after the tombstone commits - clearing the stream so a hard
    // deletion keeps nothing, and dropping cached responses because a cache hit never reaches
    // `getDoc` and would otherwise keep serving what was computed moments ago
    await promise.all([
      // add a tombstone message to the stream after trying to trim
      (tombstone.hard ? this.stream.clearMessages(room) : promise.resolve()).finally(() => this.stream.addMessage(room, { type: 'ydoc:tombstone:v1' })),
      this.stream.deleteCachedResponses(room)
    ])
    return tombstone.hard ? purgeDoc(this, room) : tombstone
  }

  /**
   * Undo a soft deletion, making the document readable again. Its content was never touched, so
   * it comes back with its full history.
   *
   * Refuses a hard deletion, and a soft one whose content was already purged: in both cases
   * dropping the record would resurrect the document as a partial one, since `retrieveDoc`
   * merges every row it finds and a straggling compaction may have left some behind.
   *
   * @param {t.Room} room
   * @returns {Promise<void>}
   */
  async restoreDoc (room) {
    const tombstone = await this.persistence.retrieveTombstone(room)
    if (tombstone == null) return
    if (tombstone.hard || tombstone.purgedAt != null) {
      throw new Error(`cannot restore ${room.org}/${room.docid}/${room.branch}: its content was erased`)
    }
    await this.persistence.deleteTombstone(room)
  }

  /**
   * The deletions recorded for `org` - what a retention task iterates to find the documents
   * whose content is due to be erased, hard-deleting each one it sweeps up.
   *
   * @param {string} org
   * @param {object} [filters]
   * @param {boolean} [filters.purged] `false` selects deletions whose content still exists
   * @param {number} [filters.before] only deletions whose `deletedAt` precedes this unix-ms timestamp
   * @returns {Promise<Array<t.Tombstone>>}
   */
  getTombstones (org, filters) {
    return this.persistence.retrieveTombstones(org, filters)
  }

  /**
   * Attribute and persist a document directly to the database, without distributing it via redis.
   *
   * Changes won't be synced to users connected via websocket until they reconnect.
   *
   * @param {t.Room} room
   * @param {Uint8Array<ArrayBuffer>} ydoc
   * @param {{ by?: string }} attributions
   */
  async unsafePersistDoc (room, ydoc, { by }) {
    const ms = await this.stream.getTime()
    const lastClock = `${ms}-I`
    const contentids = Y.createContentIdsFromUpdate(ydoc)
    /**
     * @type {Y.ContentAttribute<any>[]}
     */
    const insertAttrs = [Y.createContentAttribute('insertAt', ms)]
    /**
     * @type {Y.ContentAttribute<any>[]}
     */
    const deleteAttrs = [Y.createContentAttribute('deleteAt', ms)]
    if (by != null) {
      insertAttrs.push(Y.createContentAttribute('insert', by))
      deleteAttrs.push(Y.createContentAttribute('delete', by))
    }
    const contentmap = Y.createContentMapFromContentIds(contentids, insertAttrs, deleteAttrs)
    await this.persistence.store(room, { lastClock, gcDoc: ydoc, nongcDoc: ydoc, contentids: Y.encodeContentIds(contentids), contentmap: Y.encodeContentMap(contentmap) })
  }

  /**
   * @template R
   * @param {t.Room} room
   * @param {import('./agents.js').AgentTaskOptions} opts
   * @param {(ydoc: Y.Doc, awareness: import('@y/protocols/awareness').Awareness) => Promise<R> | R} handler
   * @returns {Promise<R>}
   */
  agentTask (room, opts, handler) {
    return agentTask(this, room, opts, handler)
  }
}

/**
 * @template {t.YHubConfig} Conf
 * @param {Conf} conf
 */
export const createYHub = async conf => {
  t.$config.expect(conf)
  const stream = await strm.createStream(conf)
  const pers = await p.createPersistence(conf.postgres, conf.persistence)
  const yhub = new YHub(conf, stream, pers)
  await promise.all(conf.persistence.map(p => p.init?.(yhub)))
  if (conf.server != null) {
    yhub.server = /** @type {any} */ (await server.createYHubServer(yhub, conf))
  }
  log.info({
    redisPrefix: conf.redis.prefix,
    pluginCount: conf.persistence.length,
    workerConcurrency: conf.worker?.taskConcurrency ?? null,
    computePoolSize: yhub.computePool.maxPoolSize,
    serverPort: conf.server?.port ?? null
  }, 'yhub initialized')
  yhub.startWorker().catch(err => log.error({ err }, 'worker failed'))
  // @todo start workers _after_ persistence plugin is done. Otherwise, workers might use
  // persistence.
  return yhub
}
