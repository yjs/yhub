import * as t from  './types.js'
import * as s from 'lib0/schema'
import * as random from 'lib0/random'
import * as number from 'lib0/number'
import * as redis from 'redis'
import * as promise from 'lib0/promise'
import * as buffer from 'lib0/buffer'
import * as array from 'lib0/array'
import * as map from 'lib0/map'

/**
 * @typedef {object} StreamSubscriber
 * @property {(room: t.Room, ms:Array<t.Message & { redisClock: string }>)=>any} onMessage
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

/**
 * 
 */
export class YHubStream {
  /**
   * @param {import('./config.js').RedisConfig} config
   */
  constructor (config) {
    this.config = config
    this.prefix = config.prefix || 'yhub'
    this.consumername = random.uuidv4()
    /**
     * After this timeout, a worker will pick up a task and clean up a stream.
     */
    this.taskDebounce = config.taskDebounce
    /**
     * Minimum lifetime of y* update messages in redis streams.
     */
    this.minMessageLifetime = config.minMessageLifetime
    this.workerStreamName = this.prefix + ':worker'
    this.workerGroupName = this.prefix + ':worker'
    this._destroyed = false
    /**
     * lastReceivedId: the last id we received. Next time we fetch we will request lastReceivedId+1.
     * A sub doesn't receive subs that are smaller/equal to lastReceivedId.
     *
     * @type {Map<string, { lastReceivedClock: string, subs: StreamSubscriber[] }>}
     */
    this.subs = new Map()
    /**
     * Will be merged into subs on the next sub iteration.
     *
     * @type {Map<string, { lastReceivedClock: string, subs: StreamSubscriber[] }>}
     */
    this.subUpdates = new Map()
    this.redis = redis.createClient({
      url: config.url,
      // scripting: https://github.com/redis/node-redis/#lua-scripts
      scripts: {
        addMessage: redis.defineScript({
          NUMBER_OF_KEYS: 1,
          SCRIPT: `
            if redis.call("EXISTS", KEYS[1]) == 0 then
              local id = redis.call("XADD", "${this.workerStreamName}", "*", "compact", KEYS[1])
              redis.call("XCLAIM", "${this.workerStreamName}", "${this.workerGroupName}", "pending", 0, id)
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
        trimMessages: redis.defineScript({
          NUMBER_OF_KEYS: 1,
          SCRIPT: `
            redis.call("XDEL", "${this.workerStreamName}", ARGV[2])
            local minid = (redis.call("TIME")[1] * 1000) - tonumber(ARGV[1])
            redis.call("XTRIM", KEYS[1], "MINID", minid)
            if redis.call("XLEN", KEYS[1]) == 0 then
              redis.call("DEL", KEYS[1])
            else
              local id = redis.call("XADD", "${this.workerStreamName}", "*", "compact", KEYS[1])
              redis.call("XCLAIM", "${this.workerStreamName}", "${this.workerGroupName}", "pending", 0, id)
            end
          `,
          /**
           * @param {string} streamName
           * @param {number} maxAgeMs
           * @param {string} taskId
           */
          transformArguments (streamName, maxAgeMs, taskId) {
            return [streamName, maxAgeMs.toString(), taskId]
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
    /**
     * Second instance to fetch things concurrent to the other connection.
     *
     * @type {typeof this.redis | null}
     */
    this.redisSubscriptions = null
    this._subRunning = false
  }

  async _runSub () {
    if (!this._subRunning) {
      this._subRunning = true
      if (this.redisSubscriptions === null) {
        this.redisSubscriptions = redis.createClient({ url: this.config.url })
      }
      while (this.subs.size > 0 || this.subUpdates.size > 0) {
        // update subs
        this.subUpdates.forEach((update, streamName) => {
          const s = map.setIfUndefined(this.subs, streamName, () => ({ lastReceivedClock: update.lastReceivedClock, subs: /** @type {StreamSubscriber[]} */ ([]) }))
          if (isSmallerRedisClock(update.lastReceivedClock, s.lastReceivedClock)) {
            s.lastReceivedClock = update.lastReceivedClock
          }
          s.subs.push(...update.subs)
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
                }
                s.onMessage(m.room, filteredMessages)
              })
              sub.lastReceivedClock = m.lastClock
            }
          }
          if (ms.length > 0) {
            console.info('pulled', ms.length, ' messages and notified ', nsubCounter, 'subscribers')
          }
        } catch (e) {
          console.error(e)
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
    const reads = await redisClient.xRead(
      redis.commandOptions({ returnBuffers: true }),
      streams,
      blocking ? { BLOCK: 200, COUNT: 1000 } : {}
    )
    /**
     * @type {Array<{ room: t.Room, streamName: string, messages: Array<t.Message & { redisClock: string }>, lastClock: string }>}
     */
    const res = []
    reads?.forEach(stream => {
      const streamName = stream.name.toString()
      res.push({
        room: decodeRoomName(streamName, this.prefix),
        streamName: streamName,
        lastClock: array.last(stream.messages).id.toString(),
        messages: stream.messages.filter(m => m.message.m != null).map(message => {
          const dm = buffer.decodeAny(/** @type {Uint8Array<ArrayBuffer>} */ (message.message.m))
          dm.redisClock = message.id
          return dm
        })
      })
    })
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
    const s = map.setIfUndefined(this.subUpdates, streamName, () => ({ lastReceivedClock: subscriber.lastReceivedClock, subs: /** @type {StreamSubscriber[]} */ ([]) }))
    s.subs.push(subscriber)
    this._runSub()
  }

  /**
   * @param {number} count
   * @return {Promise<Array<t.Task & { redisClock: string }>>}
   */
  async claimTasks (count) {
    const reclaimedTasks = await this.redis.xAutoClaim(this.workerStreamName, this.workerGroupName, this.consumername, this.taskDebounce, '0', { COUNT: count })
    const tasks = reclaimedTasks.messages.map(m => {
      if (m?.message.compact != null) {
        return {
          type: /** @type {const} */ ('compact'),
          room: decodeRoomName(m.message.compact, this.prefix),
          redisClock: m?.id
        }
      } else {
        console.error('found unknown task type', m?.message)
        return null
      }
    }).filter(t => t != null)
    return tasks
  }

  /**
   * @param {t.Room} room
   * @param {number} maxAgeMs
   * @param {string?} taskid
   */
  async trimMessages (room, maxAgeMs, taskid) {
    await this.redis.trimMessages(encodeRoomName(room, this.prefix), maxAgeMs, taskid || '')
  }
}
