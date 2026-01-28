import * as promise from 'lib0/promise'
import * as config from './config.js'
import * as strm from './stream.js'
import * as p from './persistence.js'
import * as t from './types.js'
import * as Y from '@y/y'
import * as s from 'lib0/schema'

export class YHub {
  /**
   * @param {strm.YHubStream} str
   * @param {p.Persistence} pers
   */
  constructor (str, pers) {
    this.stream = str
    this.persistence = pers
  }

  /**
   * @template {{ gc?: boolean, nongc?: boolean, contentmap?: boolean, references?: boolean, contentids?: boolean }} Include
   * @param {string} org
   * @param {string} docid
   * @param {string} branch
   * @param {Include} includeContent
   * @return {Promise<t.DocTable<Include>>}
   */
  async getDoc (org, docid, branch, includeContent) {
    const [persistedDoc, cachedMessages] = await promise.all([
      this.persistence.retrieveDoc(org, docid, branch, includeContent),
      this.stream.getMessages([{ room: { org, docid, branch }, clock: '0' }]).then(ms => ms[0] || { messages: [], lastClock: '0' })
    ])
    const gcDoc = persistedDoc.gcDoc
    const nongcDoc = persistedDoc.nongcDoc
    const contentmap = persistedDoc.contentmap
    const contentids = persistedDoc.contentids
    const references = persistedDoc.references
    const lastClock = strm.maxRedisClock(persistedDoc.lastClock, cachedMessages.lastClock)
    cachedMessages.messages.forEach(m => {
      if (t.$updateMessage.check(m)) {
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
      references
    }
  }

  /**
   * @param {string} org
   * @param {string} docid
   * @param {string} branch
   * @param {string?} taskid
   * @return {Promise<t.DocTable<{ gc: true, nongc: true, contentmap: true, contentids: true }> | null>}
   */
  async compactDoc (org, docid, branch, taskid) {
    const d = await this.getDoc(org, docid, branch, { gc: true, nongc: true, contentmap: true, contentids: true, references: true })
    if (!strm.isSmallerRedisClock(d.lastPersistedClock, d.lastClock)) {
      return null
    }
    await this.persistence.store(org, docid, branch, d)
    await promise.all([
      this.persistence.deleteReferences(d.references),
      this.stream.trimMessages({ org, docid, branch }, this.stream.minMessageLifetime, taskid)
    ])
    return d
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
 * @param {config.YHubConfig} conf
 */
export const createYHub = async conf => {
  config.$config.expect(conf)
  const str = new strm.YHubStream(conf.redis)
  const pers = await p.createPersistence(conf.postgres, conf.persistence)
  return new YHub(str, pers)
}

export class YHubWorker {
  /**
   * @param {YHub} yhub
   * @param {t.YHubWorkerConf} conf
   */
  constructor (yhub, conf) {
    this.yhub = yhub
    this.conf = t.$yhubWorkerConf.expect(conf)
    this._ctx = {
      shouldRun: false
    }
  }
  async start () {
    this._ctx.shouldRun = false
    const ctx = (this._ctx = {
      shouldRun: true
    })
    while (ctx.shouldRun) {
      try {
        const tasks = await this.yhub.stream.claimTasks(this.conf.taskConcurrency)
        await promise.all(tasks.map(async task => {
          const { org, docid, branch } = task.room
          const compactResult = await this.yhub.compactDoc(org, docid, branch, task.redisClock)
          if (compactResult != null) {
            this.conf.callbacks.compact(compactResult)
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
  stop () {
    this._ctx.shouldRun = false
  }
}

/**
 * @param {YHub} yhub
 * @param {t.YHubWorkerConf} conf
 */
export const createWorker = (yhub, conf) => new YHubWorker(yhub, conf)
