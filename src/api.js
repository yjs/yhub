import * as Y from '@y/y'
import * as redis from 'redis'
import * as map from 'lib0/map'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from '@y/protocols/awareness'
import * as array from 'lib0/array'
import * as random from 'lib0/random'
import * as number from 'lib0/number'
import * as promise from 'lib0/promise'
import * as math from 'lib0/math'
import * as protocol from './protocol.js'
import * as env from 'lib0/environment'
import * as logging from 'lib0/logging'
import * as s from 'lib0/schema'

const logWorker = logging.createModuleLogger('@y/hub/api/worker')
const logApi = logging.createModuleLogger('@y/hub/api')

export const $redisUpdateMessage = s.$({ type: s.$literal('update:v1'), attributions: s.$uint8Array.optional, update: s.$uint8Array })
export const $redisAwarenessMessage = s.$({ type: s.$literal('awarenes:v1'), update: s.$uint8Array })
export const $redisMessage = s.$union($redisUpdateMessage, $redisAwarenessMessage)

/**
 * @typedef {s.Unwrap<typeof $redisMessage>} RedisMessage
 */

/**
 * @param {Uint8Array} m
 * @return {RedisMessage}
 */
export const parseRedisMessage = m => decoding.readAny(decoding.createDecoder(m))

/**
 * @param {RedisMessage} m
 * @return {Uint8Array}
 */
export const encodeRedisMessage = m => encoding.encode(encoder => encoding.writeAny(encoder, m))

export const redisUrl = env.ensureConf('redis')

/**
 * @param {string} a
 * @param {string} b
 * @return {boolean} iff a < b
 */
export const isSmallerRedisId = (a, b) => {
  const [a1, a2 = '0'] = a.split('-')
  const [b1, b2 = '0'] = b.split('-')
  const a1n = number.parseInt(a1)
  const b1n = number.parseInt(b1)
  return a1n < b1n || (a1n === b1n && number.parseInt(a2) < number.parseInt(b2))
}

/**
 * @param {import('@redis/client/dist/lib/commands/generic-transformers.js').StreamsMessagesReply} streamReply
 * @param {string} prefix
 */
const extractMessagesFromStreamReply = (streamReply, prefix) => {
  /**
   * @type {Map<string, Map<string, { lastId: string, messages: Array<Uint8Array> }>>}
   */
  const messages = new Map()
  streamReply?.forEach(docStreamReply => {
    const { room, docid } = decodeRedisRoomStreamName(docStreamReply.name.toString(), prefix)
    const docMessages = map.setIfUndefined(
      map.setIfUndefined(
        messages,
        room,
        map.create
      ),
      docid,
      () => ({ lastId: array.last(docStreamReply.messages).id, messages: /** @type {Array<Uint8Array>} */ ([]) })
    )
    docStreamReply.messages.forEach(m => {
      if (m.message.m != null) {
        docMessages.messages.push(/** @type {Uint8Array} */ (m.message.m))
      }
    })
  })
  return messages
}

/**
 * @param {string} room
 * @param {string} docid
 * @param {string} branch
 * @param {string} prefix
 */
export const computeRedisRoomStreamName = (room, docid, branch, prefix) => `${prefix}:room:${encodeURIComponent(room)}:${encodeURIComponent(docid)}:${encodeURIComponent(branch)}`

/**
 * @param {string} rediskey
 * @param {string} expectedPrefix
 */
const decodeRedisRoomStreamName = (rediskey, expectedPrefix) => {
  const match = rediskey.match(/^(.*):room:(.*):(.*):(.*?)$/)
  if (match == null || match[1] !== expectedPrefix) {
    throw new Error(`Malformed stream name! prefix="${match?.[1]}" expectedPrefix="${expectedPrefix}", rediskey="${rediskey}"`)
  }
  return { room: decodeURIComponent(match[2]), docid: decodeURIComponent(match[3]), branch: decodeURIComponent(match[4]) }
}

/**
 * @param {import('./storage.js').Storage} store
 * @param {string} redisPrefix
 */
export const createApiClient = async (store, redisPrefix) => {
  const a = new Api(store, redisPrefix)
  await a.redis.connect()
  try {
    await a.redis.xGroupCreate(a.redisWorkerStreamName, a.redisWorkerGroupName, '0', { MKSTREAM: true })
  } catch (e) { }
  return a
}

export class Api {
  /**
   * @param {import('./storage.js').Storage} store
   * @param {string} prefix
   */
  constructor (store, prefix) {
    this.store = store
    this.sql = store.sql
    this.prefix = prefix
    this.consumername = random.uuidv4()
    /**
     * After this timeout, a worker will pick up a task and clean up a stream.
     */
    this.redisTaskDebounce = number.parseInt(env.getConf('redis-task-debounce') || '10000') // default: 10 seconds
    /**
     * Minimum lifetime of y* update messages in redis streams.
     */
    this.redisMinMessageLifetime = number.parseInt(env.getConf('redis-min-message-lifetime') || '60000') // default: 1 minute
    this.redisWorkerStreamName = this.prefix + ':worker'
    this.redisWorkerGroupName = this.prefix + ':worker'
    this._destroyed = false
    this.redis = redis.createClient({
      url: redisUrl,
      // scripting: https://github.com/redis/node-redis/#lua-scripts
      scripts: {
        addMessage: redis.defineScript({
          NUMBER_OF_KEYS: 1,
          SCRIPT: `
            if redis.call("EXISTS", KEYS[1]) == 0 then
              redis.call("XADD", "${this.redisWorkerStreamName}", "*", "compact", KEYS[1])
              redis.call("XREADGROUP", "GROUP", "${this.redisWorkerGroupName}", "pending", "STREAMS", "${this.redisWorkerStreamName}", ">")
            end
            redis.call("XADD", KEYS[1], "*", "m", ARGV[1])
          `,
          /**
           * @param {string} key
           * @param {Buffer} message
           */
          transformArguments (key, message) {
            return [key, message]
          },
          /**
           * @param {null} x
           */
          transformReply (x) {
            return x
          }
        }),
        xDelIfEmpty: redis.defineScript({
          NUMBER_OF_KEYS: 1,
          SCRIPT: `
            if redis.call("XLEN", KEYS[1]) == 0 then
              redis.call("DEL", KEYS[1])
            end
          `,
          /**
           * @param {string} key
           */
          transformArguments (key) {
            return [key]
          },
          /**
           * @param {null} x
           */
          transformReply (x) {
            return x
          }
        })
      }
    })
  }

  /**
   * @param {Array<{key:string,id:string}>} streams streamname-clock pairs
   * @return {Promise<Array<{ stream: string, messages: Array<Uint8Array>, lastId: string }>>}
   */
  async getMessages (streams) {
    if (streams.length === 0) {
      await promise.wait(50)
      return []
    }
    const reads = await this.redis.xRead(
      redis.commandOptions({ returnBuffers: true }),
      streams,
      { BLOCK: 1000, COUNT: 1000 }
    )
    /**
     * @type {Array<{ stream: string, messages: Array<Uint8Array>, lastId: string }>}
     */
    const res = []
    reads?.forEach(stream => {
      res.push({
        stream: stream.name.toString(),
        messages: protocol.mergeMessages(stream.messages.map(message => /** @type {Uint8Array<ArrayBuffer>} */ (message.message.m)).filter(m => m != null)),
        lastId: array.last(stream.messages).id.toString()
      })
    })
    return res
  }

  /**
   * @param {string} room
   * @param {string} docid
   * @param {RedisMessage} m
   * @param {object} opts
   * @param {string} [opts.branch]
   */
  addMessage (room, docid, m, { branch = 'main' } = {}) {
    return this.redis.addMessage(computeRedisRoomStreamName(room, docid, branch, this.prefix), Buffer.from(encodeRedisMessage(m)))
  }

  /**
   * @param {string} room
   * @param {string} docid
   * @param {Object} opts
   * @param {boolean} [opts.gc]
   * @param {string} [opts.branch]
   */
  async getStateVector (room, docid = '/', { gc = true, branch = 'main' } = {}) {
    return this.store.retrieveStateVector(room, docid, { gc, branch })
  }

  /**
   * @template {boolean} [IncludeAttributions=false]
   * @param {string} room
   * @param {string} docid
   * @param {Object} [opts]
   * @param {boolean} [opts.gc]
   * @param {string} [opts.branch]
   * @param {IncludeAttributions} [opts.attributions]
   * @return {Promise<{ ydoc: Y.Doc, awareness: awarenessProtocol.Awareness, redisLastId: string, storeReferences: { db: Array<number>, s3: Array<string> }?, docChanged: boolean, attributions: IncludeAttributions extends true ? Y.ContentMap : null}>}
   */
  async getDoc (room, docid, { gc = true, branch = 'main', attributions } = {}) {
    logApi(`getDoc(${room}, ${docid}, gc=${gc}, branch=${branch})`)
    const ms = extractMessagesFromStreamReply(await this.redis.xRead(redis.commandOptions({ returnBuffers: true }), { key: computeRedisRoomStreamName(room, docid, branch, this.prefix), id: '0' }), this.prefix)
    const docMessages = ms.get(room)?.get(docid) || null
    logApi(`getDoc(${room}, ${docid}, gc=${gc}, branch=${branch}) - retrieved ${docMessages?.messages.length || 0} messages`)
    const docstate = await this.store.retrieveDoc(room, docid, { gc, branch, yContentMap: attributions })
    let contentMapAttributions = docstate?.yContentMap || (attributions ? Y.mergeContentMaps([]) : null)
    logApi(`getDoc(${room}, ${docid}, gc=${gc}, branch=${branch}) - retrieved doc`)
    const ydoc = new Y.Doc({ gc })
    const awareness = new awarenessProtocol.Awareness(ydoc)
    awareness.setLocalState(null) // we don't want to propagate awareness state
    if (docstate) { Y.applyUpdate(ydoc, docstate.doc) }
    let docChanged = false
    ydoc.once('afterTransaction', tr => {
      docChanged = tr.changed.size > 0
    })
    ydoc.transact(() => {
      docMessages?.messages.forEach(m => {
        const message = parseRedisMessage(m)
        switch (message.type) {
          case 'update:v1': {
            Y.applyUpdate(ydoc, message.update)
            if (message.attributions != null && contentMapAttributions != null) {
              contentMapAttributions = Y.mergeContentMaps([contentMapAttributions, Y.excludeContentMaps(Y.decodeContentMap(message.attributions), contentMapAttributions)])
            }
            break
          }
          case 'awarenes:v1': {
            awarenessProtocol.applyAwarenessUpdate(awareness, message.update, null)
            break
          }
          default: {
            console.error('Received unknown message type. This might cause dataloss!', JSON.stringify(message))
          }
        }
      })
    })
    return { ydoc, awareness, redisLastId: docMessages?.lastId.toString() || '0', storeReferences: docstate?.references || null, docChanged, attributions: /** @type {any} */ (contentMapAttributions) }
  }

  /**
   * @param {WorkerOpts} opts
   */
  async consumeWorkerQueue ({ tryClaimCount = 5, updateCallback = async () => {} }) {
    /**
     * @type {Array<{stream: string, id: string}>}
     */
    const tasks = []
    const reclaimedTasks = await this.redis.xAutoClaim(this.redisWorkerStreamName, this.redisWorkerGroupName, this.consumername, this.redisTaskDebounce, '0', { COUNT: tryClaimCount })
    reclaimedTasks.messages.forEach(m => {
      const stream = m?.message.compact
      stream && tasks.push({ stream, id: m?.id })
    })
    if (tasks.length === 0) {
      logWorker('No tasks available, pausing..', { tasks })
      await promise.wait(1000)
      return []
    }
    logWorker('Accepted tasks ', { tasks })
    await promise.all(tasks.map(async task => {
      const streamlen = await this.redis.xLen(task.stream)
      if (streamlen === 0) {
        await this.redis.multi()
          .xDelIfEmpty(task.stream)
          .xDel(this.redisWorkerStreamName, task.id)
          .exec()
        logWorker('Stream still empty, removing recurring task from queue ', { stream: task.stream })
      } else {
        const { room, docid, branch } = decodeRedisRoomStreamName(task.stream, this.prefix)
        // @todo, make sure that awareness by this.getDoc is eventually destroyed, or doesn't
        // register a timeout anymore
        logWorker('requesting doc from store')
        // Persist both gc'd and non-gc'd versions
        const gcResult = await this.getDoc(room, docid, { gc: true, branch })
        const nonGcResult = await this.getDoc(room, docid, { gc: false, branch, attributions: true })
        logWorker('retrieved doc from store. redisLastId=' + gcResult.redisLastId, ' gcRefs=' + JSON.stringify(gcResult.storeReferences), ' nonGcRefs=' + JSON.stringify(nonGcResult.storeReferences))
        const lastId = math.max(number.parseInt(gcResult.redisLastId.split('-')[0]), number.parseInt(task.id.split('-')[0]))
        if (gcResult.docChanged || nonGcResult.docChanged) {
          try {
            logWorker('doc changed, calling update callback')
            // Use gc'd version for callback
            await updateCallback(room, gcResult.ydoc)
          } catch (e) {
            console.error(e)
          }
          logWorker('persisting both gc and non-gc versions')
          console.log('stored attributions', nonGcResult.attributions, gcResult.attributions)
          await promise.all([
            gcResult.docChanged ? this.store.persistDoc(room, docid, gcResult.ydoc, gcResult.attributions, { gc: true, branch }) : promise.resolve(),
            nonGcResult.docChanged ? this.store.persistDoc(room, docid, nonGcResult.ydoc, nonGcResult.attributions, { gc: false, branch }) : promise.resolve()
          ])
        }

        // @todo write attributions here
        console.log('attributions', nonGcResult.attributions)
        await promise.all([
          gcResult.storeReferences && gcResult.docChanged ? this.store.deleteReferences(room, docid, gcResult.storeReferences, { gc: true, branch }) : promise.resolve(),
          nonGcResult.storeReferences && nonGcResult.docChanged ? this.store.deleteReferences(room, docid, nonGcResult.storeReferences, { gc: false, branch }) : promise.resolve(),
          // if `redisTaskDebounce` is small, or if updateCallback taskes too long, then we might
          // add a task twice to this list.
          // @todo either use a different datastructure or make sure that task doesn't exist yet
          // before adding it to the worker queue
          // This issue is not critical, as no data will be lost if this happens.
          this.redis.multi()
            .xTrim(task.stream, 'MINID', lastId - this.redisMinMessageLifetime)
            .xAdd(this.redisWorkerStreamName, '*', { compact: task.stream })
            .xReadGroup(this.redisWorkerGroupName, 'pending', { key: this.redisWorkerStreamName, id: '>' }, { COUNT: 50 }) // immediately claim this entry, will be picked up by worker after timeout
            .xDel(this.redisWorkerStreamName, task.id)
            .exec()
        ])
        logWorker('Compacted stream ', { stream: task.stream, taskId: task.id, newLastId: lastId - this.redisMinMessageLifetime })
      }
    }))
    return tasks
  }

  async destroy () {
    this._destroyed = true
    try {
      await this.redis.quit()
    } catch (e) {}
  }
}

/**
 * @typedef {Object} WorkerOpts
 * @property {(room: string, ydoc: Y.Doc) => Promise<void>} [WorkerOpts.updateCallback]
 * @property {number} [WorkerOpts.tryClaimCount]
 */

/**
 * @param {import('./storage.js').Storage} store
 * @param {string} redisPrefix
 * @param {WorkerOpts} opts
 */
export const createWorker = async (store, redisPrefix, opts) => {
  const a = await createApiClient(store, redisPrefix)
  return new Worker(a, opts)
}

export class Worker {
  /**
   * @param {Api} client
   * @param {WorkerOpts} opts
   */
  constructor (client, opts) {
    this.client = client
    logWorker('Created worker process ', { id: client.consumername, prefix: client.prefix, minMessageLifetime: client.redisMinMessageLifetime })
    ;(async () => {
      while (!client._destroyed) {
        try {
          await client.consumeWorkerQueue(opts)
        } catch (e) {
          console.error(e)
        }
      }
      logWorker('Ended worker process ', { id: client.consumername })
    })()
  }
}
