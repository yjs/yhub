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
 * @property {(docRef: t.DocRef, ms:Array<t.Message & { redisClock: string }>)=>any} onStreamMessage
 * @property {()=>void} destroy
 * @property {(code: number, message: string)=>void} closeWithError
 * @property {string} lastReceivedClock
 */

/**
 * @typedef {Pick<ReturnType<typeof redis.createClient>, 'withTypeMapping'>} RedisReadClient
 */

/**
 * Percent-encode a docRef component for use inside a redis key.
 *
 * `encodeURIComponent` leaves `!'()*` unescaped, and `*` is a redis glob metacharacter - a docid
 * like `draft*` would otherwise widen any `KEYS`/`SCAN` pattern built from it to match foreign
 * documents. The rest of redis' glob syntax (`?`, `[`, `]`, `\`, `^`) is already escaped;  `-` is
 * only special inside `[..]`, which cannot occur once `[` is escaped. `:` is escaped too, so the
 * key's own separator stays unambiguous.
 *
 * @param {string} str
 */
export const uriEncode = str => encodeURIComponent(str).replace(
  /[!'()*]/g,
  c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
)

/**
 * Inverse of `uriEncode`. It is exactly `decodeURIComponent`: the extra characters `uriEncode`
 * escapes are ordinary `%XX` sequences, which `decodeURIComponent` already understands. Named
 * for symmetry, so call sites pair visibly and nobody has to re-derive that.
 *
 * @param {string} str
 */
export const uriDecode = str => decodeURIComponent(str)

// The ':room:'/'quarantine_room' redis key spellings — and these encode/decode function names,
// which name that spelling — are deliberately kept during the room→docRef rename: changing the
// on-wire key spelling is a rolling-upgrade concern and is deferred.
/**
 * @param {t.DocRef} docRef
 * @param {string} prefix
 */
export const encodeRoomName = (docRef, prefix) => `${prefix}:room:${uriEncode(docRef.org)}:${uriEncode(docRef.docid)}:${uriEncode(docRef.branch)}`

/**
 * @param {string} rediskey
 * @param {string} expectedPrefix
 */
export const decodeRoomName = (rediskey, expectedPrefix) => {
  const match = rediskey.match(/^(.*):room:(.*):(.*):(.*?)$/)
  if (match == null || match[1] !== expectedPrefix) {
    throw new Error(`Malformed stream name! prefix="${match?.[1]}" expectedPrefix="${expectedPrefix}", rediskey="${rediskey}"`)
  }
  return { org: uriDecode(match[2]), docid: uriDecode(match[3]), branch: uriDecode(match[4]) }
}

/**
 * @param {t.DocRef} docRef
 * @param {string} prefix
 * @param {string} qid
 */
export const encodeQuarantineName = (docRef, prefix, qid) => `${prefix}:quarantine_room:${uriEncode(docRef.org)}:${uriEncode(docRef.docid)}:${uriEncode(docRef.branch)}:${qid}`

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
     * After this timeout, a worker will pick up a task and clean up a stream. (default: 120 seconds)
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
    this.compactionDisabledSetName = this.prefix + ':compaction_disabled'
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
    const redisClientOptions = config.redis.clientOptions ?? {}
    this.redisClientConf = /** @type {import('@redis/client').RedisClientOptions} */ ({
      ...redisClientOptions,
      url: config.redis.url,
      socket: /** @type {import('@redis/client').RedisClientOptions['socket']} */ ({
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
        ...redisClientOptions?.socket,
        ...config.redis.socket
      })
    })
    this.redis = redis.createClient({
      ...this.redisClientConf,
      // scripting: https://github.com/redis/node-redis/#lua-scripts
      scripts: {
        ...this.redisClientConf.scripts,
        addMessage: redis.defineScript({
          NUMBER_OF_KEYS: 1,
          SCRIPT: `
            if redis.call("EXISTS", KEYS[1]) == 0 and redis.call("SISMEMBER", "${this.compactionDisabledSetName}", KEYS[1]) == 0 then
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
            -- acked == 0 means another worker reclaimed this task (long-running worker completing
            -- late) and its trimMessages already ran — that invocation owns the stream's lifecycle.
            -- A late worker must not touch the stream: trimming/DELeting it here could delete the
            -- key while the successor task is still pending, so the next write would enqueue a
            -- second compact task and spawn a concurrent task chain for the same document.
            if acked == 1 then
              local minidLifetime = (redis.call("TIME")[1] * 1000) - tonumber(ARGV[2])
              local minid = ARGV[1]
              local minidTs = tonumber(string.match(minid, "^(%d+)"))
              if minidTs < minidLifetime then
                minidLifetime = incStreamId(minid)
              else
                minidLifetime = tostring(minidLifetime)
              end
              redis.call("XTRIM", KEYS[1], "MINID", minidLifetime)
              if redis.call("XLEN", KEYS[1]) == 0 then
                redis.call("DEL", KEYS[1])
              else
                redis.call("XADD", "${this.workerStreamName}", "*", "compact", KEYS[1])
                redis.call("XREADGROUP", "GROUP", "${this.workerGroupName}", "pending", "COUNT", 1, "STREAMS", "${this.workerStreamName}", ">")
              end
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
        }),
        disableCompaction: redis.defineScript({
          NUMBER_OF_KEYS: 1,
          SCRIPT: `
            redis.call("SADD", "${this.compactionDisabledSetName}", KEYS[1])
            local tasks = redis.call("XRANGE", "${this.workerStreamName}", "-", "+")
            for _, task in ipairs(tasks) do
              if task[2][1] == "compact" and task[2][2] == KEYS[1] then
                redis.call("XACK", "${this.workerStreamName}", "${this.workerGroupName}", task[1])
                redis.call("XDEL", "${this.workerStreamName}", task[1])
              end
            end
          `,
          /**
           * @param {import('@redis/client').CommandParser} parser
           * @param {string} streamName
           */
          parseCommand (parser, streamName) {
            parser.pushKey(streamName)
          },
          transformReply (reply) { return reply }
        }),
        enableCompaction: redis.defineScript({
          NUMBER_OF_KEYS: 1,
          SCRIPT: `
            if redis.call("SREM", "${this.compactionDisabledSetName}", KEYS[1]) == 1 and redis.call("EXISTS", KEYS[1]) == 1 then
              redis.call("XADD", "${this.workerStreamName}", "*", "compact", KEYS[1])
              redis.call("XREADGROUP", "GROUP", "${this.workerGroupName}", "pending", "COUNT", 1, "STREAMS", "${this.workerStreamName}", ">")
            end
          `,
          /**
           * @param {import('@redis/client').CommandParser} parser
           * @param {string} streamName
           */
          parseCommand (parser, streamName) {
            parser.pushKey(streamName)
          },
          transformReply (reply) { return reply }
        })
      }
    })
    this.redis.on('error', /** @param {Error} err */ err => log.error({ err }, 'Redis client error'))
    /**
     * Second instance to fetch things concurrent to the other connection.
     *
     * @type {ReturnType<typeof redis.createClient> | null}
     */
    this.redisSubscriptions = null
    this._subRunning = false
  }

  /**
   * The current unix time in milliseconds, read from redis so that timestamps minted on
   * different servers are comparable regardless of their local clock skew. Same clock domain as
   * the stream ids, and therefore as `yhub_ydoc_v1.created`.
   *
   * @return {Promise<number>}
   */
  async getTime () {
    const [seconds, microseconds] = await this.redis.time()
    return number.parseInt(seconds) * 1000 + math.floor(number.parseInt(microseconds) / 1000)
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
      let redisSubscriptions = this.redisSubscriptions
      if (redisSubscriptions === null) {
        redisSubscriptions = redis.createClient(this.redisClientConf)
        redisSubscriptions.on('error', /** @param {Error} err */ err => log.error({ err }, 'Redis subscription client error'))
        await redisSubscriptions.connect()
        this.redisSubscriptions = redisSubscriptions
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
          const ms = await this.getMessages(array.from(this.subs.entries()).map(([docRef, s]) => ({ docRef, clock: s.lastReceivedClock })), { redisClient: redisSubscriptions, blocking: true })
          let nsubCounter = 0
          for (let i = 0; i < ms.length; i++) {
            const m = ms[i]
            const sub = this.subs.get(m.streamName)
            if (sub != null) {
              sub.subs.forEach(s => {
                const filteredMessages = m.messages.filter(m => isSmallerRedisClock(s.lastReceivedClock, m.redisClock))
                if (filteredMessages.length > 0) {
                  nsubCounter++
                  try {
                    s.onStreamMessage(m.docRef, filteredMessages)
                    s.lastReceivedClock = m.lastClock
                  } catch (err) {
                    s.closeWithError(1011, 'unexpected error when sending stream data')
                  }
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
   * @param {Array<{docRef: t.DocRef|string, clock: string}>} docRefs docRef-clock pairs
   * @param {object} opts
   * @param {RedisReadClient} [opts.redisClient]
   * @param {boolean} [opts.blocking]
   * @return {Promise<Array<{ docRef: t.DocRef, messages: Array<t.Message & { redisClock: string }>, lastClock: string, streamName: string }>>}
   */
  async getMessages (docRefs, { redisClient, blocking = false } = {}) {
    if (docRefs.length === 0) {
      await promise.wait(50)
      return []
    }
    const streams = docRefs.map(asset => ({ key: s.$string.check(asset.docRef) ? asset.docRef : encodeRoomName(asset.docRef, this.prefix), id: asset.clock || '0' }))
    log.debug({ streamCount: streams.length }, 'retrieving messages')
    const readClient = redisClient ?? this.redis
    const reads = /** @type {Array<{name: Buffer, messages: Array<{id: Buffer, message: Record<string, Buffer>}>}> | null} */ (await readClient.withTypeMapping({
      [redis.RESP_TYPES.BLOB_STRING]: Buffer
    }).xRead(
      streams,
      blocking ? { BLOCK: 200, COUNT: 5000 } : {}
    ))
    /**
     * @type {Array<{ docRef: t.DocRef, streamName: string, messages: Array<t.Message & { redisClock: string }>, lastClock: string }>}
     */
    const res = []
    reads?.forEach(stream => {
      const streamName = stream.name.toString()
      res.push({
        docRef: decodeRoomName(streamName, this.prefix),
        streamName,
        lastClock: array.last(stream.messages).id.toString(),
        messages: stream.messages.filter(m => m.message.m != null).map(message => {
          const dm = buffer.decodeAny(/** @type {Uint8Array<ArrayBuffer>} */ (message.message.m))
          dm.redisClock = message.id.toString()
          return dm
        })
      })
    })
    // allowlist, not a chain of exclusions - a new payload-free message type must not turn the
    // fallback into a type error
    log.debug({ messages: res.map(r => ({ stream: r.streamName, ms: r.messages.map(m => ({ type: m.type, size: (m.type === 'ydoc:update:v1' || m.type === 'awareness:v1' ? m.update : m.type === 'prune:v1' ? m.prune : null)?.byteLength, rclock: m.redisClock })) })) }, 'retrieved messages')
    return res
  }

  /**
   * @param {t.DocRef} docRef
   * @param {t.Message} m
   */
  addMessage (docRef, m) {
    return this.redis.addMessage(encodeRoomName(docRef, this.prefix), Buffer.from(buffer.encodeAny(m)))
  }

  /**
   * Move the live stream for `docRef` into a quarantine key with a fresh qid.
   *
   * Atomically renames the live stream and inserts a NOP entry into the (now empty) live
   * key. The NOP uses field `nop` (not `m`), so every read path — which filters on
   * `.message.m != null` — ignores it. The reason to leave a NOP behind is that any compact
   * task enqueued before the quarantine is still pending in the worker queue; a fresh write
   * after quarantine would otherwise see `EXISTS(live) == 0` and enqueue a second compact
   * task, causing two workers to persist the same `lastClock` concurrently (duplicate PK).
   *
   * @param {t.DocRef} docRef
   * @returns {Promise<string | null>} the qid of the created quarantine, or null if nothing to quarantine
   */
  async quarantine (docRef) {
    const live = encodeRoomName(docRef, this.prefix)
    const qid = random.uuidv4()
    const quar = encodeQuarantineName(docRef, this.prefix, qid)
    try {
      await this.redis.multi()
        .rename(live, quar)
        .xAdd(live, '*', { nop: '1' })
        .exec()
    } catch (e) {
      const err = /** @type {any} */ (e)
      // MULTI runs every queued command; if RENAME fails with "no such key" the XADD still
      // ran and left an orphan NOP in the live stream. Clean it up and report the no-op.
      const renameErr = err.replies?.[0]
      if (renameErr instanceof Error && renameErr.message?.includes('no such key')) {
        await this.redis.del(live)
        return null
      }
      throw e
    }
    log.warn({ docRef, qid }, 'quarantined stream')
    return qid
  }

  /**
   * List the qids of all quarantine streams for `docRef`.
   *
   * @param {t.DocRef} docRef
   * @returns {Promise<string[]>}
   */
  async getQuarantineStreams (docRef) {
    // safe to match on directly: `uriEncode` escapes every redis glob metacharacter, so no
    // org/docid/branch can widen this pattern beyond its own document
    const pattern = `${encodeQuarantineName(docRef, this.prefix, '')}*`
    /**
     * @type {Array<string>}
     */
    const qids = []
    for await (const keys of this.redis.scanIterator({ MATCH: pattern, COUNT: 1000 })) {
      keys.forEach(k => qids.push(k.slice(k.lastIndexOf(':') + 1)))
    }
    return qids
  }

  /**
   * List every quarantine stream across all documents.
   *
   * @returns {Promise<Array<{ docRef: t.DocRef, qid: string }>>}
   */
  async getAllQuarantineStreams () {
    /**
     * @type {Array<{ docRef: t.DocRef, qid: string }>}
     */
    const res = []
    // SCAN rather than KEYS - this is on the delete path, and KEYS walks the whole keyspace
    for await (const keys of this.redis.scanIterator({ MATCH: `${this.prefix}:quarantine_room:*`, COUNT: 1000 })) {
      keys.forEach(k => {
        const m = k.match(/^.*:quarantine_room:([^:]+):([^:]+):([^:]+):([^:]+)$/)
        if (m == null) throw new Error(`Malformed quarantine key: ${k}`)
        res.push({
          docRef: { org: uriDecode(m[1]), docid: uriDecode(m[2]), branch: uriDecode(m[3]) },
          qid: m[4]
        })
      })
    }
    return res
  }

  /**
   * Re-inject a quarantined stream back into the live stream for `docRef`, then delete the
   * quarantine key. Each stored message is re-XADD'd to the live stream (with a fresh redis
   * clock), which re-enqueues the compact worker task if the live stream was empty.
   *
   * @param {t.DocRef} docRef
   * @param {string} qid
   * @returns {Promise<number>} number of messages re-injected
   */
  async unquarantine (docRef, qid) {
    const quar = encodeQuarantineName(docRef, this.prefix, qid)
    const live = encodeRoomName(docRef, this.prefix)
    // Quarantined streams are expected to be read-only after quarantine() — nothing in the
    // system writes to `quarantine_room:*` keys. We rely on that here: we XRANGE the full
    // contents, then DEL the key in a follow-up write. If a concurrent writer could add to
    // the quarantine stream between these calls, the DEL would silently drop those messages.
    const entries = await this.redis.withTypeMapping({
      [redis.RESP_TYPES.BLOB_STRING]: Buffer
    }).xRange(quar, '-', '+')
    const multi = this.redis.multi()
    for (const entry of entries) {
      const m = entry.message.m
      // auth:check directives are transient (their intent was fulfilled while they were live) and
      // not replay-idempotent - re-injected with a fresh clock they would kick matching
      // connections again, so they are dropped instead
      if (m != null && buffer.decodeAny(/** @type {Uint8Array<ArrayBuffer>} */ (m)).type !== 'auth:check:v1') multi.addMessage(live, /** @type {Buffer} */ (m))
    }
    multi.del(quar)
    await multi.exec()
    log.info({ docRef, qid, count: entries.length }, 'unquarantined stream')
    return entries.length
  }

  /**
   * Drop every message from `docRef`'s stream, without removing the key.
   *
   * XTRIM, not DEL. DEL resets the stream's `last_id`, so the next entry can be assigned an id
   * that sorts *below* the clock a subscriber already advanced past within the same millisecond
   * - the connections a deletion most needs to reach are exactly the ones that were writing
   * just now, and they would silently never see it. DEL would also flip `EXISTS` to 0, letting
   * the next write enqueue a second compact task alongside the one already pending, which is
   * the same invariant `quarantine` protects with its NOP entry. Redis keeps a stream key alive
   * with zero entries, which is why `trimMessages` has to DEL explicitly.
   *
   * @param {t.DocRef} docRef
   */
  async clearMessages (docRef) {
    await this.redis.xTrim(encodeRoomName(docRef, this.prefix), 'MAXLEN', 0)
    log.info({ docRef }, 'cleared stream')
  }

  /**
   * Delete every quarantined backlog of `docRef`. Nothing else ever removes these keys - they are
   * not trimmed and not listed by `getActiveStreams` - so a purge that skipped them would leave
   * the document's content sitting in redis indefinitely.
   *
   * @param {t.DocRef} docRef
   * @return {Promise<number>} the number of deleted quarantine streams
   */
  async deleteQuarantineStreams (docRef) {
    const qids = await this.getQuarantineStreams(docRef)
    if (qids.length > 0) {
      await this.redis.del(qids.map(qid => encodeQuarantineName(docRef, this.prefix, qid)))
      log.info({ docRef, count: qids.length }, 'deleted quarantine streams')
    }
    return qids.length
  }

  /**
   * Stop workers from compacting `docRef`. Atomically removes the pending compact task from the
   * worker queue and adds the docRef to the disabled set. While disabled, no new compact task is
   * enqueued for the document (addMessage checks the set), so its stream is neither persisted nor
   * trimmed until compaction is enabled again.
   *
   * @param {t.DocRef} docRef
   */
  async disableCompaction (docRef) {
    await this.redis.disableCompaction(encodeRoomName(docRef, this.prefix))
    log.warn({ docRef }, 'disabled compaction')
  }

  /**
   * Re-enable compaction for `docRef`. Removes the docRef from the disabled set and re-enqueues a
   * compact task if its stream exists. No-op if the document wasn't disabled.
   *
   * @param {t.DocRef} docRef
   */
  async enableCompaction (docRef) {
    await this.redis.enableCompaction(encodeRoomName(docRef, this.prefix))
    log.info({ docRef }, 'enabled compaction')
  }

  /**
   * List all docRefs with disabled compaction.
   *
   * @return {Promise<Array<t.DocRef>>}
   */
  async getDisabledCompactionDocRefs () {
    return (await this.redis.sMembers(this.compactionDisabledSetName)).map(k => decodeRoomName(k, this.prefix))
  }

  /**
   * @param {t.DocRef} docRef
   * @param {StreamSubscriber} subscriber
   */
  subscribe (docRef, subscriber) {
    const streamName = encodeRoomName(docRef, this.prefix)
    log.debug({ docRef, streamName }, 'subscribing')
    const s = map.setIfUndefined(this.subUpdates, streamName, () => ({ lastReceivedClock: subscriber.lastReceivedClock, subs: /** @type {Set<StreamSubscriber>} */ (new Set()) }))
    s.lastReceivedClock = minRedisClock(s.lastReceivedClock, subscriber.lastReceivedClock)
    s.subs.add(subscriber)
    this._runSub().catch(err => log.error({ err }, 'error running subscription loop'))
  }

  /**
   * @param {t.DocRef} docRef
   * @param {StreamSubscriber} subscriber
   */
  unsubscribe (docRef, subscriber) {
    const streamName = encodeRoomName(docRef, this.prefix)
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
          docRef: decodeRoomName(m.message.compact, this.prefix),
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
   * Reset the idle time of the tasks we are still working on, so that neither another worker nor
   * our own `claimTasks` reclaims them. `JUSTID` keeps the delivery counter intact.
   *
   * A min-idle-time of `0` claims regardless of the current owner - so this also steals back a
   * task that another worker took over while we were computing. That is intentional: compaction
   * results are idempotent (both workers write the same assets and the row insert is
   * `ON CONFLICT DO NOTHING`), and whichever `trimMessages` loses the ack is a no-op anyway.
   *
   * @param {Array<string>} taskIds
   * @return {Promise<Array<string>>} the ids that are still pending - a missing id was already
   * completed or was cancelled by `disableCompaction`.
   */
  renewTasks (taskIds) {
    return this.redis.xClaimJustId(this.workerStreamName, this.workerGroupName, this.consumername, 0, taskIds)
  }

  /**
   * Trim messages with minId. Also ensure that we only trim messages that are older than maxAgeMs.
   *
   * @param {t.DocRef} docRef
   * @param {string} minId
   * @param {number} maxAgeMs
   * @param {string?} taskid
   */
  async trimMessages (docRef, minId, maxAgeMs, taskid) {
    await this.redis.trimMessages(encodeRoomName(docRef, this.prefix), minId, maxAgeMs, taskid || '')
  }

  /**
   * Key prefix of every cached response of `docRef`, terminated by its separator so that it cannot
   * also match a document whose docid merely starts with these characters.
   *
   * @param {t.DocRef} docRef
   */
  _cachePrefix (docRef) {
    return `${this.prefix}:cache:${uriEncode(docRef.org)}:${uriEncode(docRef.docid)}:${uriEncode(docRef.branch)}:`
  }

  /**
   * Drop every cached response of `docRef`. A cache hit never reaches `getDoc`, so without this a
   * response cached just before a deletion would keep being served until it expired.
   *
   * @param {t.DocRef} docRef
   * @return {Promise<number>} the number of dropped entries
   */
  async deleteCachedResponses (docRef) {
    /**
     * @type {Array<string>}
     */
    const keys = []
    for await (const batch of this.redis.scanIterator({ MATCH: `${this._cachePrefix(docRef)}*`, COUNT: 1000 })) {
      keys.push(...batch)
    }
    if (keys.length > 0) {
      await this.redis.del(keys)
      log.info({ docRef, count: keys.length }, 'dropped cached responses')
    }
    return keys.length
  }

  /**
   * Cache results for `cacheTtl + computeTime * 2`.
   *
   * The docRef leads the key so that `deleteCachedResponses` can drop everything cached for a
   * document with an exact prefix match. Every component is `uriEncode`d: they are user-controlled, and a
   * raw join would let org='a:b',docid='c' collide with org='a',docid='b:c'.
   *
   * @param {t.DocRef} docRef
   * @param {string} endpoint
   * @param {Array<string>} args
   * @param {() => Promise<Uint8Array>} computeResult
   * @return {Promise<Uint8Array | Buffer>}
   */
  async cachedGet (docRef, endpoint, args, computeResult) {
    const key = `${this._cachePrefix(docRef)}${uriEncode(endpoint)}:${args.map(uriEncode).join(':')}`
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
