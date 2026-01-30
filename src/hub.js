import * as promise from 'lib0/promise'
import * as strm from './stream.js'
import * as p from './persistence.js'
import * as t from './types.js'
import * as Y from '@y/y'
import * as object from 'lib0/object'
import * as protocol from './protocol.js'

export class YHub {
  /**
   * @param {t.YHubConfig} conf
   * @param {strm.Stream} str
   * @param {p.Persistence} pers
   */
  constructor (conf, str, pers) {
    this.conf = conf
    this.stream = str
    this.persistence = pers
    this.server = null
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
        tasks.length && console.info('[yhub-worker] picked up ' + tasks.length + ' tasks. Working on it..')
        await promise.all(tasks.map(async task => {
          if (task.type === 'compact') {
            // execute compact task
            const d = await this.getDoc(task.room, { gc: true, nongc: true, contentmap: true, contentids: true, references: true })
            if (!strm.isSmallerRedisClock(d.lastPersistedClock, d.lastClock)) {
              return null
            }
            this.conf.worker?.events?.docUpdate(object.assign({}, d, { references: null }))
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
   * @return {Promise<t.DocTable<Include>>}
   */
  async getDoc (room, includeContent) {
    const [persistedDoc, cachedMessages] = await promise.all([
      this.persistence.retrieveDoc(room, includeContent),
      this.stream.getMessages([{ room, clock: '0' }]).then(ms => ms[0] || { messages: [], lastClock: '0' })
    ])
    const gcDoc = persistedDoc.gcDoc
    const nongcDoc = persistedDoc.nongcDoc
    const contentmap = persistedDoc.contentmap
    const contentids = persistedDoc.contentids
    const references = persistedDoc.references
    const awareness = /** @type {Include['awareness'] extends true ? import('@y/protocols/awareness').Awareness : null} */ (includeContent.awareness ? protocol.mergeAwarenessUpdates(cachedMessages.messages.filter(m => m.type === 'awareness:v1').map(m => m.update)) : null)
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
      gcDoc: /** @type {Include['gc'] extends true ? Uint8Array<ArrayBuffer> : null} */ (gcDoc ? mergeUpdatesAndGc(gcDoc) : null),
      nongcDoc: /** @type {Include['nongc'] extends true ? Uint8Array<ArrayBuffer> : null} */ (nongcDoc ? Y.mergeUpdates(nongcDoc) : null),
      contentmap: /** @type {Include['contentmap'] extends true ? Uint8Array<ArrayBuffer> : null} */ (contentmap ? Y.mergeContentMaps(contentmap.map(Y.decodeContentMap)) : null),
      contentids: /** @type {Include['nongc'] extends true ? Uint8Array<ArrayBuffer> : null} */ (contentids ? Y.mergeContentIds(contentids.map(Y.decodeContentIds)) : null),
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
  const ydoc = new Y.Doc()
  updates.forEach(update => {
    Y.applyUpdate(ydoc, update)
  })
  return Y.encodeStateAsUpdate(ydoc)
}

/**
 * @param {t.YHubConfig} conf
 */
export const createYHub = async conf => {
  t.$config.expect(conf)
  const stream = new strm.Stream(conf)
  const pers = await p.createPersistence(conf.postgres, conf.persistence)
  return new YHub(conf, stream, pers)
}
