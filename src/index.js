import * as promise from 'lib0/promise'
import * as strm from './stream.js'
import * as p from './persistence.js'
import * as t from './types.js'
import * as Y from '@y/y'
import * as object from 'lib0/object'
import * as protocol from './protocol.js'
import * as server from './server.js'
import * as logging from 'lib0/logging'

export { createAuthPlugin } from './types.js'

const log = logging.createModuleLogger('@y/hub/worker')

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
        tasks.length && log(() => ['picked up ' + tasks.length + ' tasks. Working on it..', tasks])
        await promise.all(tasks.map(async task => {
          if (task.type === 'compact') {
            // execute compact task
            const d = await this.getDoc(task.room, { gc: true, nongc: true, contentmap: true, contentids: true, references: true })
            if (!strm.isSmallerRedisClock(d.lastPersistedClock, d.lastClock)) {
              await this.stream.trimMessages(task.room, d.lastClock, this.stream.minMessageLifetime, task.redisClock)
              return null
            }
            this.conf.worker?.events?.docUpdate?.(object.assign({}, d, { references: null }))
            await this.persistence.store(task.room, d)
            await promise.all([
              this.persistence.deleteReferences(d.references),
              this.stream.trimMessages(task.room, d.lastClock, this.stream.minMessageLifetime, task.redisClock)
            ])
          }
        }))
        if (tasks.length === 0) {
          await promise.wait(1000)
        }
      } catch (err) {
        console.error('[yhub-worker] error processing task: ', err)
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
      this.persistence.retrieveDoc(room, includeContent),
      this.stream.getMessages([{ room, clock: '0' }]).then(ms => ms[0] || { messages: [], lastClock: '0' })
    ])
    const gcDoc = persistedDoc.gcDoc
    const nongcDoc = persistedDoc.nongcDoc
    const contentmap = persistedDoc.contentmap
    const contentids = persistedDoc.contentids
    const references = persistedDoc.references
    const awareness = /** @type {Include['awareness'] extends true ? Uint8Array<ArrayBuffer> : null} */ (includeContent.awareness ? protocol.mergeAwarenessUpdates(cachedMessages.messages.filter(m => m.type === 'awareness:v1').map(m => m.update)) : null)
    const lastClock = strm.maxRedisClock(persistedDoc.lastClock, cachedMessages.lastClock)
    cachedMessages.messages.forEach(m => {
      // only add update messages that are newer that what we currently know
      if (t.$updateMessage.check(m) && strm.isSmallerRedisClock(persistedDoc.lastClock, m.redisClock)) {
        gcDoc?.push(m.update)
        nongcDoc?.push(m.update)
        contentmap?.push(m.contentmap)
        contentids?.push(Y.encodeContentIds(Y.createContentIdsFromContentMap(Y.decodeContentMap(m.contentmap))))
      }
    })
    return {
      gcDoc: /** @type {Include['gc'] extends true ? Uint8Array<ArrayBuffer> : null} */ (gcDoc ? (gcOnMerge ? mergeUpdatesAndGc(gcDoc) : Y.mergeUpdates(gcDoc)) : null),
      nongcDoc: /** @type {Include['nongc'] extends true ? Uint8Array<ArrayBuffer> : null} */ (nongcDoc ? Y.mergeUpdates(nongcDoc) : null),
      contentmap: /** @type {Include['contentmap'] extends true ? Uint8Array<ArrayBuffer> : null} */ (contentmap ? Y.encodeContentMap(Y.mergeContentMaps(contentmap.map(Y.decodeContentMap))) : null),
      contentids: /** @type {Include['nongc'] extends true ? Uint8Array<ArrayBuffer> : null} */ (contentids ? Y.encodeContentIds(Y.mergeContentIds(contentids.map(Y.decodeContentIds))) : null),
      lastClock,
      lastPersistedClock: persistedDoc.lastClock,
      references,
      awareness
    }
  }
}

/**
 * @param {Array<Uint8Array<ArrayBuffer>>} updates
 */
const mergeUpdatesAndGc = updates => {
  if (updates.length === 1) {
    return updates[0]
  }
  const ydoc = new Y.Doc()
  updates.forEach(update => {
    Y.applyUpdate(ydoc, update)
  })
  return Y.encodeStateAsUpdate(ydoc)
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
  yhub.startWorker()
  // @todo start workers _after_ persistence plugin is done. Otherwise, workers might use
  // persistence.
  return yhub
}
