// eslint-disable-next-line
import * as t from './types.js'
import * as s from 'lib0/schema'
import * as random from 'lib0/random'
import * as number from 'lib0/number'
import * as redis from 'redis'
import * as promise from 'lib0/promise'
import * as buffer from 'lib0/buffer'
import * as array from 'lib0/array'
import * as map from 'lib0/map'
import * as math from 'lib0/math'
import * as time from 'lib0/time'
import { logger } from './logger.js'

const log = logger.child({ module: 'stream' })

/**
 * @typedef {object} StreamSubscriber
 * @property {(room: t.Room, ms:Array<t.Message & { redisClock: string }>)=>any} onStreamMessage
 * @property {()=>void} destroy
 * @property {string} lastReceivedClock
 */

/**
 * @param {t.Room} room
 * @param {string} prefix
 */
export const encodeRoomName = (room, prefix) => `${prefix}:room:${encodeURIComponent(room.org)}:${encodeURIComponent(room.docid)}:${encodeURIComponent(room.branch)}`

/**
 * @param {string} rediskey
 * @param {string} expectedPrefix
 */
export const decodeRoomName = (rediskey, expectedPrefix) => {
  const match = rediskey.match(/^(.*):room:(.*):(.*):(.*?)$/)
  if (match == null || match[1] !== expectedPrefix) {
    throw new Error(`Malformed stream name! prefix="${match?.[1]}" expectedPrefix="${expectedPrefix}", rediskey="${rediskey}"`)
  }
  return { org: decodeURIComponent(match[2]), docid: decodeURIComponent(match[3]), branch: decodeURIComponent(match[4]) }
}

/**
 * @param {string} a
 * @param {string} b
 * @return {boolean} iff a < b
 */
export const isSmallerRedisClock = (a, b) => {
  const [a1, a2 = '0'] = a.split('-')
  const [b1, b2 = '0'] = b.split('-')
  const a1n = number.parseInt(a1)
  const b1n = number.parseInt(b1)
  return a1n < b1n || (a1n === b1n && number.parseInt(a2) < number.parseInt(b2))
}

/**
 * @param {string} a
 * @param {string} b
 * @return {string}
 */
export const maxRedisClock = (a, b) => isSmallerRedisClock(a, b) ? b : a

/**
 * @param {string} a
 * @param {string} b
 * @return {string}
 */
export const minRedisClock = (a, b) => isSmallerRedisClock(a, b) ? a : b

export class Stream {
  /**
   * @param {import('./types.js').YHubConfig} config
   */
  constructor (config) {
    this.redisConfig = config.redis
    this.prefix = config.redis.prefix || 'yhub'
    this.consumername = random.uuidv4()
    /**
     * After this timeout, a worker will pick up a task and clean up a stream. (default: 60 seconds)
     */
    this.taskDebounce = config.redis.taskDebounce ?? 120000
    /**
     * Minimum lifetime of y* update messages in redis streams. (default: 60 seconds)
     */
    this.minMessageLifetime = config.redis.minMessageLifetime ?? 60000
    /**
     * TTL for cached API responses in seconds. (default: 5 seconds)
     * Results are cached for `cacheTtl + computeTime * 2`.
     */
    this.cacheTtl = config.redis.cacheTtl ?? 5
    this.workerStreamName = this.prefix + ':worker'
    this.workerGroupName = this.prefix + ':worker'
    this._destroyed = false
    /**
     * lastReceivedId: the last id we received. Next time we fetch we will request lastReceivedId+1.
     * A sub doesn't receive subs that are smaller/equal to lastReceivedId.
     *
     * @type {Map<string, { lastReceivedClock: string, subs: Set<StreamSubscriber> }>}
     */
    this.subs = new Map()
    /**
     * Will be merged into subs on the next sub iteration.
     *
     * @type {Map<string, { lastReceivedClock: string, subs: Set<StreamSubscriber> }>}
     */
    this.subUpdates = new Map()
    this.redisClientConf = {
      url: config.redis.url,
      socket: {
        connectTimeout: 20000,
        /**
         * @param {number} retries
         */
        reconnectStrategy: retries => {
          if (retries > 1000) {
            log.fatal('Unable to connect to redis, max attempts reached, closing yhub')
            process.exit(1)
          }
          const delay = math.min(retries * 10, 3000)
          log.warn({ retries, delayMs: delay }, 'redis reconnecting')
          return delay
        },
        ...config.redis.socket
      }
    }
    this.redis = redis.createClient({
      ...this.redisClientConf,
      // scripting: https://github.com/redis/node-redis/#lua-scripts
      scripts: {
        addMessage: redis.defineScript({
          NUMBER_OF_KEYS: 1,
          SCRIPT: `
            if redis.call("EXISTS", KEYS[1]) == 0 then
              redis.call("XADD", "${this.workerStreamName}", "*", "compact", KEYS[1])
              redis.call("XREADGROUP", "GROUP", "${this.workerGroupName}", "pending", "COUNT", 1, "STREAMS", "${this.workerStreamName}", ">")
            end
            redis.call("XADD", KEYS[1], "*", "m", ARGV[1])
          `,
          /**
           * @param {import('@redis/client').CommandParser} parser
           * @param {string} key
           * @param {Buffer} message
           */
          parseCommand (parser, key, message) {
            log.debug({ key, messageSize: message.byteLength }, 'adding message')
            parser.pushKey(key)
            parser.push(message)
          },
          transformReply (reply) { return reply }
        }),
        trimMessages: redis.defineScript({
          NUMBER_OF_KEYS: 1,
          SCRIPT: `
            local function incStreamId(id)
              local ts, seq = string.match(id, "^(%d+)-?(%d*)$")
              if seq == "" then seq = "0" end
              return ts .. "-" .. (tonumber(seq) + 1)
            end
            local acked = redis.call("XACK", "${this.workerStreamName}", "${this.workerGroupName}", ARGV[3])
            redis.call("XDEL", "${this.workerStreamName}", ARGV[3])
            local minidLifetime = (redis.call("TIME")[1] * 1000) - tonumber(ARGV[2])
            local minid = ARGV[1]
            local minidTs = tonumber(string.match(minid, "^(%d+)"))
            if minidTs < minidLifetime then
              minidLifetime = incStreamId(minid)
            end
            redis.call("XTRIM", KEYS[1], "MINID", minidLifetime)
            if redis.call("XLEN", KEYS[1]) == 0 then
              redis.call("DEL", KEYS[1])
            elseif acked == 1 then
              redis.call("XADD", "${this.workerStreamName}", "*", "compact", KEYS[1])
              redis.call("XREADGROUP", "GROUP", "${this.workerGroupName}", "pending", "COUNT", 1, "STREAMS", "${this.workerStreamName}", ">")
            end
          `,
          /**
           * @param {import('@redis/client').CommandParser} parser
           * @param {string} streamName
           * @param {string} minId
           * @param {number} maxAgeMs - in milliseconds
           * @param {string} taskId
           */
          parseCommand (parser, streamName, minId, maxAgeMs, taskId) {
            parser.pushKey(streamName)
            parser.push(minId, maxAgeMs.toString(), taskId)
          },
          transformReply (reply) { return reply }
        })
      }
    })
    this.redis.on('error', /** @param {Error} err */ err => log.error({ err }, 'Redis client error'))
    /**
     * Second instance to fetch things concurrent to the other connection.
     *
     * @type {typeof this.redis | null}
     */
    this.redisSubscriptions = null
    this._subRunning = false
  }

  async getPendingTasksSize () {
    return this.redis.xLen(this.workerStreamName)
  }

  async getActiveStreams () {
    return this.redis.keys(`${this.prefix}:room:*`)
  }

  async _runSub () {
    if (!this._subRunning) {
      this._subRunning = true
      if (this.redisSubscriptions === null) {
        this.redisSubscriptions = redis.createClient(this.redisClientConf)
        this.redisSubscriptions.on('error', /** @param {Error} err */ err => log.error({ err }, 'Redis subscription client error'))
        await this.redisSubscriptions.connect()
      }
      while (this.subs.size > 0 || this.subUpdates.size > 0) {
        // update subs
        this.subUpdates.forEach((update, streamName) => {
          const s = map.setIfUndefined(this.subs, streamName, () => ({ lastReceivedClock: update.lastReceivedClock, subs: /** @type {Set<StreamSubscriber>} */ (new Set()) }))
          if (isSmallerRedisClock(update.lastReceivedClock, s.lastReceivedClock)) {
            s.lastReceivedClock = update.lastReceivedClock
          }
          update.subs.forEach(sub => s.subs.add(sub))
        })
        this.subUpdates.clear()
        try {
          const ms = await this.getMessages(array.from(this.subs.entries()).map(([room, s]) => ({ room, clock: s.lastReceivedClock })), { redisClient: this.redisSubscriptions, blocking: true })
          let nsubCounter = 0
          for (let i = 0; i < ms.length; i++) {
            const m = ms[i]
            const sub = this.subs.get(m.streamName)
            if (sub != null) {
              sub.subs.forEach(s => {
                const filteredMessages = m.messages.filter(m => isSmallerRedisClock(s.lastReceivedClock, m.redisClock))
                if (filteredMessages.length > 0) {
                  s.lastReceivedClock = m.lastClock
                  nsubCounter++
                  s.onStreamMessage(m.room, filteredMessages)
                }
              })
              sub.lastReceivedClock = m.lastClock
            }
          }
          ms.length > 0 && log.debug({ messageCount: ms.length, subscriberCount: nsubCounter }, 'pulled messages and notified subscribers')
        } catch (e) {
          log.error({ err: e }, 'error in subscription loop')
          await promise.wait(3000)
        }
      }
      this._subRunning = false
    }
  }

  /**
   * @param {Array<{room: t.Room|string, clock: string}>} rooms room-clock pairs
   * @param {object} opts
   * @param {typeof this.redis} [opts.redisClient]
   * @param {boolean} [opts.blocking]
   * @return {Promise<Array<{ room: t.Room, messages: Array<t.Message & { redisClock: string }>, lastClock: string, streamName: string }>>}
   */
  async getMessages (rooms, { redisClient = this.redis, blocking = false } = {}) {
    if (rooms.length === 0) {
      await promise.wait(50)
      return []
    }
    const streams = rooms.map(asset => ({ key: s.$string.check(asset.room) ? asset.room : encodeRoomName(asset.room, this.prefix), id: asset.clock || '0' }))
    log.debug({ streamCount: streams.length }, 'retrieving messages')
    const reads = /** @type {Array<{name: Buffer, messages: Array<{id: Buffer, message: Record<string, Buffer>}>}> | null} */ (await redisClient.withTypeMapping({
      [redis.RESP_TYPES.BLOB_STRING]: Buffer
    }).xRead(
      streams,
      blocking ? { BLOCK: 200, COUNT: 5000 } : {}
    ))
    /**
     * @type {Array<{ room: t.Room, streamName: string, messages: Array<t.Message & { redisClock: string }>, lastClock: string }>}
     */
    const res = []
    reads?.forEach(stream => {
      const streamName = stream.name.toString()
      res.push({
        room: decodeRoomName(streamName, this.prefix),
        streamName,
        lastClock: array.last(stream.messages).id.toString(),
        messages: stream.messages.filter(m => m.message.m != null).map(message => {
          const dm = buffer.decodeAny(/** @type {Uint8Array<ArrayBuffer>} */ (message.message.m))
          dm.redisClock = message.id.toString()
          return dm
        })
      })
    })
    log.debug({ messages: res.map(r => ({ stream: r.streamName, ms: r.messages.map(m => ({ type: m.type, size: m.update.byteLength, rclock: m.redisClock })) })) }, 'retrieved messages')
    return res
  }

  /**
   * @param {t.Room} room
   * @param {t.Message} m
   */
  addMessage (room, m) {
    return this.redis.addMessage(encodeRoomName(room, this.prefix), Buffer.from(buffer.encodeAny(m)))
  }

  /**
   * @param {t.Room} room
   * @param {StreamSubscriber} subscriber
   */
  subscribe (room, subscriber) {
    const streamName = encodeRoomName(room, this.prefix)
    log.debug({ room, streamName }, 'subscribing')
    const s = map.setIfUndefined(this.subUpdates, streamName, () => ({ lastReceivedClock: subscriber.lastReceivedClock, subs: /** @type {Set<StreamSubscriber>} */ (new Set()) }))
    s.lastReceivedClock = minRedisClock(s.lastReceivedClock, subscriber.lastReceivedClock)
    s.subs.add(subscriber)
    this._runSub().catch(err => log.error({ err }, 'error running subscription loop'))
  }

  /**
   * @param {t.Room} room
   * @param {StreamSubscriber} subscriber
   */
  unsubscribe (room, subscriber) {
    const streamName = encodeRoomName(room, this.prefix)
    const subUpdates = this.subUpdates.get(streamName)
    const subs = this.subs.get(streamName)
    subUpdates?.subs.delete(subscriber)
    subs?.subs.delete(subscriber)
    if (subUpdates?.subs.size === 0) {
      this.subUpdates.delete(streamName)
    }
    if (subs?.subs.size === 0) {
      this.subs.delete(streamName)
    }
  }

  /**
   * @param {number} count
   * @return {Promise<Array<t.Task & { redisClock: string }>>}
   */
  async claimTasks (count) {
    const reclaimedTasks = await this.redis.xAutoClaim(this.workerStreamName, this.workerGroupName, this.consumername, this.taskDebounce, '0', { COUNT: count })
    if (reclaimedTasks.deletedMessages != null && reclaimedTasks.deletedMessages.length > 0) {
      log.warn({ deletedMessages: reclaimedTasks.deletedMessages }, 'deleting ghost tasks from stream')
      const multi = this.redis.multi()
      for (const id of reclaimedTasks.deletedMessages) {
        multi.xAck(this.workerStreamName, this.workerGroupName, id)
        multi.xDel(this.workerStreamName, id)
      }
      multi.exec().catch(err => log.error({ err }, 'error cleaning up ghost tasks'))
    }
    const tasks = reclaimedTasks.messages.map(m => {
      if (m?.message.compact != null) {
        return {
          type: /** @type {const} */ ('compact'),
          room: decodeRoomName(m.message.compact, this.prefix),
          redisClock: m?.id
        }
      } else if (m === null) {
        log.warn('deleting ghost task from stream')
        return null
      } else {
        log.error({ keys: Object.keys(m?.message ?? {}) }, 'found unknown task type')
        return null
      }
    }).filter(t => t != null)
    return tasks
  }

  /**
   * Trim messages with minId. Also ensure that we only trim messages that are older than maxAgeMs.
   *
   * @param {t.Room} room
   * @param {string} minId
   * @param {number} maxAgeMs
   * @param {string?} taskid
   */
  async trimMessages (room, minId, maxAgeMs, taskid) {
    await this.redis.trimMessages(encodeRoomName(room, this.prefix), minId, maxAgeMs, taskid || '')
  }

  /**
   * Cache results for `cacheTtl + computeTime * 2`.
   *
   * @param {string} endpoint
   * @param {Array<string>} args
   * @param {() => Promise<Uint8Array>} computeResult
   * @return {Promise<Uint8Array | Buffer>}
   */
  async cachedGet (endpoint, args, computeResult) {
    const key = `${this.prefix}:cache:${endpoint}:${args.join(':')}`
    const cached = await /** @type {Promise<Buffer | null>} */ (this.redis.withTypeMapping({
      [redis.RESP_TYPES.BLOB_STRING]: Buffer
    }).get(key))
    if (cached != null) {
      log.debug({ endpoint, size: cached.byteLength }, 'cache hit')
      return cached
    }
    log.debug({ endpoint }, 'cache miss')
    const startTime = time.getUnixTime()
    const result = await computeResult()
    const computeTime = math.floor((time.getUnixTime() - startTime) / 1000)
    if (result.byteLength < 100 * 1000 * 1000) {
      // only cache if content is smaller than 100mb
      this.redis.set(key, Buffer.from(result), { EX: this.cacheTtl + computeTime * 2 }).catch(err => log.error({ err }, 'error caching result'))
    }
    return result
  }
}

/**
 * @param {import('./types.js').YHubConfig} config
 */
export const createStream = async config => {
  const ystream = new Stream(config)
  await ystream.redis.connect()
  // Initialize worker stream and consumer group if they don't exist
  try {
    await ystream.redis.xGroupCreate(ystream.workerStreamName, ystream.workerGroupName, '0', { MKSTREAM: true })
  } catch (e) {
    // BUSYGROUP means the group already exists, which is fine
    if (/** @type {any} */ (e).message?.includes('BUSYGROUP')) {
      // ignore
    } else {
      throw e
    }
  }
  return ystream
}
