import * as promise from 'lib0/promise'
import * as strm from './stream.js'
import * as p from './persistence.js'
import * as t from './types.js'
import * as Y from '@y/y'
import * as object from 'lib0/object'
import * as protocol from './protocol.js'
import * as server from './server.js'
import * as math from 'lib0/math'
import { createComputePool } from './compute.js'
import { agentTask } from './agents.js'
import { logger } from './logger.js'
import * as time from 'lib0/time'

export { createAuthPlugin } from './types.js'
export { logger } from './logger.js'

const log = logger.child({ module: 'worker' })

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
    this.computePool = createComputePool()
    this._workerCtx = {
      shouldRun: false
    }
  }

  async startWorker () {
    if (this._workerCtx.shouldRun || this.conf.worker == null) return
    // create new worker context
    const ctx = (this._ctx = {
      shouldRun: true
    })
    while (ctx.shouldRun) {
      try {
        const tasks = await this.stream.claimTasks(this.conf.worker.taskConcurrency)
        tasks.length && log.info({ taskCount: tasks.length }, 'picked up tasks')
        await promise.all(tasks.map(async task => {
          const taskLog = log.child({ taskType: task.type, room: task.room })
          if (task.type === 'compact') {
            /**
             * @type {Error | null}
             */
            let taskErr = null
            const taskTs = time.getUnixTime()
            try {
              this.conf.worker?.events?.taskStart?.({ room: task.room, timestamp: taskTs })
              taskLog.info('task started')
              // execute compact task
              const d = await this.getDoc(task.room, { gc: true, nongc: true, contentmap: true, contentids: true, references: true })
              if (!strm.isSmallerRedisClock(d.lastPersistedClock, d.lastClock)) {
                taskLog.debug('nothing to compact, trimming only')
                await this.stream.trimMessages(task.room, d.lastClock, this.stream.minMessageLifetime, task.redisClock)
                taskLog.info('task completed (trim only)')
                return null
              }
              this.conf.worker?.events?.docUpdate?.(object.assign({}, d, { references: null }))
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
        }))
        tasks.length && log.info({ taskCount: tasks.length }, 'completed tasks')
        if (tasks.length === 0) {
          await promise.wait(1000)
        }
      } catch (err) {
        log.error({ err }, 'error processing task')
        await promise.wait(3000)
      }
    }
  }

  stopWorker () {
    this._workerCtx.shouldRun = false
  }

  /**
   * @template {{ gc?: boolean, nongc?: boolean, contentmap?: boolean, references?: boolean, contentids?: boolean, awareness?: boolean }} Include
   * @param {t.Room} room
   * @param {Include} includeContent
   * @param {object} opts
   * @param {boolean} [opts.gcOnMerge] whether to gc when merging updates. (default: true)
   * @return {Promise<t.DocTable<Include>>}
   */
  async getDoc (room, includeContent, { gcOnMerge = true } = {}) {
    const [persistedDoc, cachedMessages] = await promise.all([
      this.persistence.retrieveDoc(room, object.assign({}, includeContent, { contentids: /** @type {const} */ (true) })),
      this.stream.getMessages([{ room, clock: '0' }]).then(ms => ms[0] || { messages: [], lastClock: '0' })
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
      references,
      awareness
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
    const { contentmap } = await this.getDoc(room, { contentmap: true })
    if (contentmap == null) return
    const prune = await this.computePool.computePruneSet({ contentmapBin: contentmap, ...filters }, { room })
    if (prune != null) {
      await this.stream.addMessage(room, { type: 'prune:v1', prune })
    }
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
    const [seconds, microseconds] = await this.stream.redis.time()
    const ms = parseInt(seconds) * 1000 + math.floor(parseInt(microseconds) / 1000)
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
