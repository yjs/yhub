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
import * as error from 'lib0/error'
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
 * The zset of `org`'s documents with live stream content, scored by the ms of the stream id of
 * their last change (see `isContentMessage`; the `addMessage` script adds the member, `trimMessages`
 * removes it together with the emptied stream - the two share a lifetime). It is the fresh half of
 * the updated-documents listing; the persisted half is `yhub_ydoc_v1.created` and the tombstones.
 * The braces around the org are a redis cluster hash tag - inert until the stream keys carry the
 * same tag.
 *
 * @param {string} org
 * @param {string} prefix
 */
export const encodeDocUpdatedKey = (org, prefix) => `${prefix}:doc_updated:{${uriEncode(org)}}`

/**
 * @param {t.DocRef} docRef
 */
export const encodeDocUpdatedMember = docRef => `${uriEncode(docRef.docid)}:${uriEncode(docRef.branch)}`

/**
 * The zset of every org that ever changed a document, one member `{org}:{t}` per org
 * (`encodeOrgUpdatedMember` - `t` being the org's last-change clock in `encodeOrgLastChangeKey`),
 * scored by when this index *learned* of that change: the redis TIME (ms) of the `updateOrgsScript`
 * call that raised `t` - raised past the latest stamp when the clock is behind it, so each call
 * stamps strictly after every earlier one, even when redis's clock steps back (a failover to a
 * replica whose clock is behind, an NTP step). And never below `t` itself: after such a step a
 * stream keeps its ids ahead of the clock, and `GET /updated/v1/{org}` lists a change only once
 * the clock passed it - a cursor that moved past the org before then would never list it again
 * (its `t` stays put while the clock catches up). The learn clock can thus run a ms ahead in a
 * burst of calls, or as far as a step went until the clock catches up. It is the cursor of the global
 * updated listing (`GET /updated/v1`): each
 * process writes its orgs in batches (`markOrgUpdated`), so a change can reach the index well
 * after its own clock - a cursor over the change clocks would skip it, one over the learn clock
 * cannot. One range read returns org, `t` and learn clock alike.
 *
 * `updateOrgsScript` swaps an org's member when its `t` goes up, finding the old one through the
 * hash. Neither key may therefore be edited by hand: a member the hash no longer names would be
 * listed forever. Neither carries a TTL, so `volatile-lru` (DEPLOYMENT.md) never evicts them.
 *
 * Written through `updateOrgsScript` only: by every process from its own `addMessage` calls, by the
 * worker right before it trims a stream (which repairs a batch lost in a crash), and by
 * `unsafePersistDoc`. It starts empty - an org enters with its first change after the deployment,
 * or when the worker compacts one of its documents, with that document's last change (which can be
 * older than the org's).
 *
 * The braces are a redis cluster hash tag shared with `encodeOrgLastChangeKey`: the script and the
 * reads of `Stream.getUpdatedOrgs` touch both keys, which must therefore live in one slot.
 *
 * @param {string} prefix
 */
export const encodeOrgUpdatedKey = prefix => `${prefix}:org_updated:{orgs}`

/**
 * The hash of every org's last-change clock: org → the ms of the stream id of its last content
 * message (the max over its documents' `doc_updated` scores). Only ever raised - see
 * `updateOrgsScript`. It names each org's member in `encodeOrgUpdatedKey`, whose hash tag it shares.
 *
 * @param {string} prefix
 */
export const encodeOrgLastChangeKey = prefix => `${prefix}:org_last_change:{orgs}`

/**
 * `updateOrgsScript` builds the same string.
 *
 * @param {string} org
 * @param {string|number} t
 */
export const encodeOrgUpdatedMember = (org, t) => `${org}:${t}`

/**
 * Splits at the last colon - `t` is digits, the org may contain colons.
 *
 * @param {string} member
 * @return {{ org: string, t: number }}
 */
export const decodeOrgUpdatedMember = member => {
  const i = member.lastIndexOf(':')
  return { org: member.slice(0, i), t: number.parseInt(member.slice(i + 1)) }
}

/**
 * @param {Array<string>} reply - of TIME: seconds, microseconds
 */
const timeReplyToMs = ([seconds, microseconds]) => number.parseInt(seconds) * 1000 + math.floor(number.parseInt(microseconds) / 1000)

/**
 * Raise orgs' last-change clocks, and stamp every org whose clock went up with the time the index
 * learned of it - swapping its member for one with the new `t`. Both members are built from the
 * string the hash holds, so the old one is always found. The stamp is TIME, or the latest stamp + 1
 * if that is higher: stamps strictly increase - and at least the org's `t`, a stream clock that can
 * run ahead of TIME (see `encodeOrgUpdatedKey`). An org whose clock did not go up keeps
 * its stamp: whatever it reports was already learned - stamped after that change happened - so
 * restamping would only list it again (the worker reports every compacted document's clock).
 */
const updateOrgsScript = `
  -- KEYS[1]  the learned zset (encodeOrgUpdatedKey)
  -- KEYS[2]  the last-change hash (encodeOrgLastChangeKey)
  -- ARGV     org, t pairs - t: unix ms of the org's last change
  local time = redis.call("TIME")
  local now = time[1] * 1000 + math.floor(time[2] / 1000)
  local latest = redis.call("ZRANGE", KEYS[1], -1, -1, "WITHSCORES")
  if latest[2] then now = math.max(now, tonumber(latest[2]) + 1) end
  for i = 1, #ARGV, 2 do
    local org, t = ARGV[i], ARGV[i + 1]
    local known = redis.call("HGET", KEYS[2], org)
    if known == false or tonumber(t) > tonumber(known) then
      if known then redis.call("ZREM", KEYS[1], org .. ":" .. known) end
      redis.call("HSET", KEYS[2], org, t)
      redis.call("ZADD", KEYS[1], math.max(now, tonumber(t)), org .. ":" .. t)
    end
  end
`

/**
 * @param {string} member
 * @return {{ docid: string, branch: string }}
 */
export const decodeDocUpdatedMember = member => {
  const i = member.indexOf(':')
  return { docid: uriDecode(member.slice(0, i)), branch: uriDecode(member.slice(i + 1)) }
}

/**
 * Map a clock whose sequence is not a number to the valid stream id `${ms}-0`. Older releases
 * stamped the rows of `unsafePersistDoc` with `${ms}-I`, which redis rejects - and a single
 * rejected id fails the shared `XREAD` of every document subscribed on the server.
 *
 * @param {string} clock
 * @return {string}
 */
export const sanitizeRedisClock = clock => {
  const [ms, seq] = clock.split('-')
  return seq == null || /^\d+$/.test(seq) ? clock : `${ms}-0`
}

/**
 * A non-numeric sequence (see `sanitizeRedisClock`) counts as 0.
 *
 * @param {string} a
 * @param {string} b
 * @return {boolean} iff a < b
 */
export const isSmallerRedisClock = (a, b) => {
  const [a1, a2] = a.split('-')
  const [b1, b2] = b.split('-')
  const a1n = number.parseInt(a1)
  const b1n = number.parseInt(b1)
  return a1n < b1n || (a1n === b1n && (number.parseInt(a2) || 0) < (number.parseInt(b2) || 0))
}

/**
 * @param {string} a
 * @param {string} b
 * @return {string}
 */
export const maxRedisClock = (a, b) => isSmallerRedisClock(a, b) ? b : a

/**
 * The unix ms of a redis clock (`${ms}-${seq}`) - `yhub_ydoc_v1.created` of a row stamped with it.
 *
 * @param {string} clock
 * @return {number}
 */
export const redisClockToMs = clock => number.parseInt(clock.split('-')[0])

/**
 * @param {string} a
 * @param {string} b
 * @return {string}
 */
export const minRedisClock = (a, b) => isSmallerRedisClock(a, b) ? a : b

/**
 * Raise the last-change clock of each org, stamping the orgs whose clock went up as learned now
 * (see `updateOrgsScript`) - a lower clock than the stored one is ignored.
 *
 * @internal - not part of the public api, which only reads the index (`Stream.getUpdatedOrgs`)
 * @param {Stream} stream
 * @param {Map<string, number>} orgs org → unix ms of its last change
 */
export const writeOrgsUpdated = async (stream, orgs) => {
  await stream.redis.updateOrgs(stream.orgUpdatedKey, stream.orgLastChangeKey, orgs)
}

/**
 * Note that `org` changed at `ms`. Collected per process and written by the next
 * `flushOrgUpdates`, at most `orgUpdatedFlushInterval` later. After `destroy` the mark is dropped
 * - the change is on the stream, and the worker's write before trimming reports it.
 *
 * @internal - not part of the public api
 * @param {Stream} stream
 * @param {string} org
 * @param {number} ms
 */
export const markOrgUpdated = (stream, org, ms) => {
  if (stream._destroyed) return
  if ((stream._orgUpdates.get(org) ?? -1) < ms) stream._orgUpdates.set(org, ms)
  stream._orgUpdatesTimeout ??= setTimeout(() => {
    stream._orgUpdatesTimeout = null
    flushOrgUpdates(stream)
  }, stream.orgUpdatedFlushInterval)
}

/**
 * Write the orgs collected by `markOrgUpdated` in one request. A failed write is merged back and
 * retried with the next flush (dropped after `destroy`, like any mark). While redis is unreachable
 * the write is not sent at all and fails the same way: node-redis would queue it until redis is
 * back, and each flush meanwhile would queue another.
 *
 * @internal - not part of the public api
 * @param {Stream} stream
 */
export const flushOrgUpdates = async stream => {
  const batch = stream._orgUpdates
  if (batch.size === 0) return
  stream._orgUpdates = new Map()
  try {
    if (!stream.redis.isReady) throw error.create('redis is not ready')
    await writeOrgsUpdated(stream, batch)
  } catch (err) {
    log.error({ err, orgCount: batch.size }, 'error flushing updated orgs')
    batch.forEach((ms, org) => markOrgUpdated(stream, org, ms))
  }
}

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
    /**
     * Ms between flushes of the orgs this process changed to `encodeOrgUpdatedKey`. (default: 1000)
     */
    this.orgUpdatedFlushInterval = config.redis.orgUpdatedFlushInterval ?? 1000
    /**
     * Ms `destroy` waits for redis to answer the commands already sent, before it drops the
     * connections.
     */
    this.closeTimeout = 10000
    this.orgUpdatedKey = encodeOrgUpdatedKey(this.prefix)
    this.orgLastChangeKey = encodeOrgLastChangeKey(this.prefix)
    /**
     * org → ms of its last change, not yet flushed to `orgUpdatedKey`
     *
     * @type {Map<string, number>}
     */
    this._orgUpdates = new Map()
    /**
     * @type {ReturnType<typeof setTimeout>|null}
     */
    this._orgUpdatesTimeout = null
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
          NUMBER_OF_KEYS: 2,
          SCRIPT: `
            -- KEYS[1]  the document's stream (encodeRoomName)
            -- KEYS[2]  the org's updated-documents zset (encodeDocUpdatedKey)
            -- ARGV[1]  the document's member in that zset (encodeDocUpdatedMember)
            -- ARGV[2]  "1" if the message changes the document (isContentMessage), "0" otherwise -
            --          the message itself is an opaque lib0 blob, so this travels separately
            -- ARGV[3]  the lib0-any encoded message
            -- returns the stream id of the appended entry
            if redis.call("EXISTS", KEYS[1]) == 0 and redis.call("SISMEMBER", "${this.compactionDisabledSetName}", KEYS[1]) == 0 then
              redis.call("XADD", "${this.workerStreamName}", "*", "compact", KEYS[1])
              redis.call("XREADGROUP", "GROUP", "${this.workerGroupName}", "pending", "COUNT", 1, "STREAMS", "${this.workerStreamName}", ">")
            end
            local id = redis.call("XADD", KEYS[1], "*", "m", ARGV[3])
            if ARGV[2] == "1" then
              redis.call("ZADD", KEYS[2], "GT", string.match(id, "^(%d+)"), ARGV[1])
            end
            return id
          `,
          /**
           * @param {import('@redis/client').CommandParser} parser
           * @param {string} key
           * @param {string} docUpdatedKey
           * @param {string} member
           * @param {boolean} isContent
           * @param {Buffer} message
           */
          parseCommand (parser, key, docUpdatedKey, member, isContent, message) {
            log.debug({ key, messageSize: message.byteLength }, 'adding message')
            parser.pushKey(key)
            parser.pushKey(docUpdatedKey)
            parser.push(member, isContent ? '1' : '0', message)
          },
          transformReply (reply) { return reply }
        }),
        trimMessages: redis.defineScript({
          NUMBER_OF_KEYS: 2,
          SCRIPT: `
            -- KEYS[1]  the document's stream (encodeRoomName)
            -- KEYS[2]  the org's updated-documents zset (encodeDocUpdatedKey)
            -- ARGV[1]  minId: the last stream id the worker processed (the persisted row covers every
            --          content entry up to it) - entries up to it may go
            -- ARGV[2]  maxAgeMs: entries younger than this stay regardless (minMessageLifetime)
            -- ARGV[3]  the compact task id to ack, or "" for none
            -- ARGV[4]  the document's member in the zset (encodeDocUpdatedMember)
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
                redis.call("ZREM", KEYS[2], ARGV[4])
              else
                redis.call("XADD", "${this.workerStreamName}", "*", "compact", KEYS[1])
                redis.call("XREADGROUP", "GROUP", "${this.workerGroupName}", "pending", "COUNT", 1, "STREAMS", "${this.workerStreamName}", ">")
              end
            end
          `,
          /**
           * @param {import('@redis/client').CommandParser} parser
           * @param {string} streamName
           * @param {string} docUpdatedKey
           * @param {string} minId
           * @param {number} maxAgeMs - in milliseconds
           * @param {string} taskId
           * @param {string} member
           */
          parseCommand (parser, streamName, docUpdatedKey, minId, maxAgeMs, taskId, member) {
            parser.pushKey(streamName)
            parser.pushKey(docUpdatedKey)
            parser.push(minId, maxAgeMs.toString(), taskId, member)
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
        }),
        updateOrgs: redis.defineScript({
          NUMBER_OF_KEYS: 2,
          SCRIPT: updateOrgsScript,
          /**
           * @param {import('@redis/client').CommandParser} parser
           * @param {string} learnedKey
           * @param {string} lastChangeKey
           * @param {Map<string, number>} orgs org → unix ms of its last change
           */
          parseCommand (parser, learnedKey, lastChangeKey, orgs) {
            parser.pushKey(learnedKey)
            parser.pushKey(lastChangeKey)
            orgs.forEach((t, org) => parser.push(org, t.toString()))
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
    return timeReplyToMs(await this.redis.time())
  }

  async getPendingTasksSize () {
    return this.redis.xLen(this.workerStreamName)
  }

  async getActiveStreams () {
    return this.redis.keys(`${this.prefix}:room:*`)
  }

  /**
   * The documents of `org` with live stream content whose last change has a stream clock at or
   * after `from` (unix ms), oldest first - see `encodeDocUpdatedKey` - and `now`, the redis time
   * (ms) read in the same transaction right after the index: a change appended after the read is
   * at `now` or later. `to` (inclusive) bounds the read when a single millisecond is read whole.
   *
   * @param {string} org
   * @param {object} range
   * @param {number} range.from
   * @param {number} [range.to]
   * @param {number} [range.limit]
   * @return {Promise<{ docs: Array<{ docid: string, branch: string, t: number }>, now: number }>}
   */
  async getUpdatedDocs (org, { from, to, limit }) {
    const [members, time] = /** @type {[Array<{ value: string, score: number }>, Array<string>]} */ (/** @type {unknown} */ (await this.redis.multi().zRangeWithScores(encodeDocUpdatedKey(org, this.prefix), from, to ?? '+inf', { BY: 'SCORE', ...(limit == null ? {} : { LIMIT: { offset: 0, count: limit } }) }).time().exec()))
    return { docs: members.map(({ value, score }) => ({ ...decodeDocUpdatedMember(value), t: score })), now: timeReplyToMs(time) }
  }

  /**
   * One page of the orgs the index learned a change of after `since` (a learn clock - see
   * `encodeOrgUpdatedKey` - exclusive), oldest first, each with its last-change clock `t`, and the
   * cursor `next` of the following page. The page never splits a learned millisecond, so `limit` is
   * soft. Without `limit` the page holds every org learned after `since`.
   *
   * Stamps strictly increase (`updateOrgsScript`), so whatever is stamped after a read is past its
   * `next`. And `next` never names the millisecond the page was read in (redis TIME, read in the
   * same transaction right after the index): the orgs learned in it are listed again on the next
   * page, so the change of a listed org that a consumer looks up within that millisecond is not
   * missed (`GET /updated/v1/{org}` ends before the current millisecond). A page that lists orgs
   * can therefore return `next === since`.
   *
   * `orgs` restricts the page to the listed orgs - only their entries are read, so the cost follows
   * the list, not the number of orgs in the index. An empty list lists no org. `'*'` reads the index
   * by score. The list must hold unique entries, in any order - the caller filters duplicates (the
   * normalized global `orgs` facet already has): an org named twice would be listed twice.
   *
   * @param {object} page
   * @param {number} page.since
   * @param {number} [page.limit]
   * @param {'*' | Array<string>} page.orgs
   * @return {Promise<{ orgs: Array<{ org: string, t: number }>, next: number }>}
   */
  async getUpdatedOrgs ({ since, limit, orgs }) {
    /**
     * @type {Array<{ org: string, t: number, learned: number }>}
     */
    let page
    let now
    if (orgs === '*') {
      const reply = /** @type {[Array<{ value: string, score: number }>, Array<string>]} */ (/** @type {unknown} */ (await this.redis.multi().zRangeWithScores(this.orgUpdatedKey, `(${since}`, '+inf', { BY: 'SCORE', ...(limit == null ? {} : { LIMIT: { offset: 0, count: limit } }) }).time().exec()))
      now = timeReplyToMs(reply[1])
      let members = reply[0]
      if (limit != null && members.length >= limit) {
        // the millisecond at the end of a full page is read whole - an org restamped in between is above it
        const cut = array.last(members).score
        members = members.filter(m => m.score < cut).concat(await this.redis.zRangeWithScores(this.orgUpdatedKey, cut, cut, { BY: 'SCORE' }))
      }
      page = members.map(({ value, score }) => ({ ...decodeOrgUpdatedMember(value), learned: score }))
    } else {
      if (orgs.length === 0) return { orgs: [], next: since }
      const reply = /** @type {[Array<string|null>, Array<string>]} */ (/** @type {unknown} */ (await this.redis.multi().hmGet(this.orgLastChangeKey, orgs).time().exec()))
      now = timeReplyToMs(reply[1])
      const members = orgs.flatMap((org, i) => {
        const t = reply[0][i]
        return t == null ? [] : [encodeOrgUpdatedMember(org, t)]
      })
      // a member gone since the first read was restamped after it, above every stamp listed here - past `next`, so it is listed with its new stamp
      const learned = members.length === 0 ? [] : await this.redis.zmScore(this.orgUpdatedKey, members)
      page = members.flatMap((member, i) => {
        const l = learned[i]
        return l == null || l <= since ? [] : [{ ...decodeOrgUpdatedMember(member), learned: l }]
      }).sort((a, b) => a.learned - b.learned)
      if (limit != null && page.length > limit) {
        const cut = page[limit - 1].learned
        page = page.filter(e => e.learned <= cut)
      }
    }
    return { orgs: page.map(({ org, t }) => ({ org, t })), next: page.length > 0 ? math.max(since, math.min(array.last(page).learned, now - 1)) : since }
  }

  /**
   * Pull messages for all subscribed streams until no subscriber is left.
   *
   * `_subRunning` must be released on *every* exit path. A throw that left it set (a failing
   * `connect()`, most likely) would make every later `subscribe` believe a loop is already
   * running, and the process would silently stop delivering stream messages.
   */
  async _runSub () {
    if (this._subRunning) return
    this._subRunning = true
    try {
      let redisSubscriptions = this.redisSubscriptions
      if (redisSubscriptions === null) {
        redisSubscriptions = redis.createClient(this.redisClientConf)
        redisSubscriptions.on('error', /** @param {Error} err */ err => log.error({ err }, 'Redis subscription client error'))
        await redisSubscriptions.connect()
        this.redisSubscriptions = redisSubscriptions
      }
      while (!this._destroyed && (this.subs.size > 0 || this.subUpdates.size > 0)) {
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
              // subscribers at the same clock get the same array instance - `WSUser` memoizes the
              // encoded frames on its identity, so it must not be mutated after the fan-out.
              // Messages are in clock order, so the unseen ones are a suffix.
              /**
               * @type {Map<number, Array<t.Message & { redisClock: string }>>}
               */
              const slices = new Map()
              sub.subs.forEach(s => {
                const start = m.messages.findIndex(msg => isSmallerRedisClock(s.lastReceivedClock, msg.redisClock))
                if (start >= 0) {
                  const filteredMessages = map.setIfUndefined(slices, start, () => start === 0 ? m.messages : m.messages.slice(start))
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
          // `destroy` rejected the read
          if (this._destroyed) break
          log.error({ err: e }, 'error in subscription loop')
          await promise.wait(3000)
        }
      }
    } finally {
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
    const streams = docRefs.map(asset => ({ key: s.$string.check(asset.docRef) ? asset.docRef : encodeRoomName(asset.docRef, this.prefix), id: sanitizeRedisClock(asset.clock || '0') }))
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
  async addMessage (docRef, m) {
    const isContent = t.isContentMessage(m.type)
    const id = await this.redis.addMessage(encodeRoomName(docRef, this.prefix), encodeDocUpdatedKey(docRef.org, this.prefix), encodeDocUpdatedMember(docRef), isContent, Buffer.from(buffer.encodeAny(m)))
    isContent && markOrgUpdated(this, docRef.org, redisClockToMs(id))
    return id
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
      // the index entry goes too: the live key survives (the NOP), but the changes it indexed moved
      // away, and a listing that kept it would have pollers refetch a document whose fetch answers
      // the pre-quarantine state until compaction deletes the key
      await this.redis.multi()
        .rename(live, quar)
        .xAdd(live, '*', { nop: '1' })
        .zRem(encodeDocUpdatedKey(docRef.org, this.prefix), encodeDocUpdatedMember(docRef))
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
    // the reply index of the last re-injected content message - its id is the org's last change
    let lastContent = -1
    let queued = 0
    for (const entry of entries) {
      const m = entry.message.m
      if (m == null) continue
      const type = buffer.decodeAny(/** @type {Uint8Array<ArrayBuffer>} */ (m)).type
      // auth:check directives are transient (their intent was fulfilled while they were live) and
      // not replay-idempotent - re-injected with a fresh clock they would kick matching
      // connections again, so they are dropped instead
      if (type !== 'auth:check:v1') {
        if (t.isContentMessage(type)) lastContent = queued
        multi.addMessage(live, encodeDocUpdatedKey(docRef.org, this.prefix), encodeDocUpdatedMember(docRef), t.isContentMessage(type), /** @type {Buffer} */ (m))
        queued++
      }
    }
    multi.del(quar)
    const replies = await multi.exec()
    if (lastContent >= 0) markOrgUpdated(this, docRef.org, redisClockToMs(/** @type {any} */ (replies[lastContent])))
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
   * Close both redis clients. The commands sent before the call get up to `closeTimeout` to be
   * answered, so the messages the closing connections just added still reach redis. Then whatever
   * is still unanswered is rejected and both connections are dropped: neither an unresponsive nor
   * an unreachable redis can hold `destroy`. The subscription loop exits when its current read is
   * rejected.
   */
  async destroy () {
    /** @type {any} */
    let timeout
    await Promise.race([(async () => {
      // replies arrive in order, so once the ping's reply has arrived, every write sent before it
      // has been answered - and a timer later their org marks (a few promise hops behind each
      // reply) have run, in time for the flush below. Sent while redis is reconnecting too: the writes queued meanwhile get
      // their chance. A failed ping, a write that had to retry (NOSCRIPT) or one sent after this
      // leaves its mark to the worker's repair.
      await this.redis.ping().catch(() => {})
      await promise.wait(0)
      this._destroyed = true
      // the orgs changed since the last flush
      if (this._orgUpdatesTimeout != null) clearTimeout(this._orgUpdatesTimeout)
      this._orgUpdatesTimeout = null
      await flushOrgUpdates(this)
    })(), promise.create(resolve => { timeout = setTimeout(resolve, this.closeTimeout) })])
    clearTimeout(timeout)
    this._destroyed = true
    // `close()` would wait for every queued reply, and can't be aborted once called. `destroy()`
    // rejects the pending commands, which also ends the drain above if it ran out of time
    this.redis.destroy()
    this.redisSubscriptions?.destroy()
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
    // ids to drop from the queue: ghosts redis already deleted from the stream, plus compact
    // entries whose key doesn't decode. The latter will never become decodable, so leaving them
    // pending hands them back to us - and to every other worker - on every round, forever.
    const discard = [...(reclaimedTasks.deletedMessages ?? [])]
    if (discard.length > 0) log.warn({ deletedMessages: discard }, 'deleting ghost tasks from stream')
    /**
     * @type {Array<t.Task & { redisClock: string }>}
     */
    const tasks = []
    for (const m of reclaimedTasks.messages) {
      if (m == null) {
        // an entry that was deleted from the stream but is still pending - redis reports the id
        // in `deletedMessages`, not here, so there is nothing to clean up
        log.warn('found ghost task in stream')
      } else if (m.message.compact == null) {
        // not garbage - this is what a task type added by a newer release looks like to us. Leave
        // it pending for a worker that understands it; deleting it here would silently drop that
        // release's work for the length of a rolling upgrade.
        log.warn({ id: m.id, task: m.message }, 'found unknown task type, leaving it for another worker')
      } else {
        try {
          tasks.push({ type: 'compact', docRef: decodeRoomName(m.message.compact, this.prefix), redisClock: m.id })
        } catch (err) {
          log.error({ err, id: m.id, compact: m.message.compact }, 'discarding undecodable task')
          discard.push(m.id)
        }
      }
    }
    if (discard.length > 0) {
      const multi = this.redis.multi()
      discard.forEach(id => {
        multi.xAck(this.workerStreamName, this.workerGroupName, id)
        multi.xDel(this.workerStreamName, id)
      })
      // best effort - a failed cleanup just means we discard it again next round
      multi.exec().catch(err => log.error({ err }, 'error cleaning up tasks'))
    }
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
    await this.redis.trimMessages(encodeRoomName(docRef, this.prefix), encodeDocUpdatedKey(docRef.org, this.prefix), sanitizeRedisClock(minId), maxAgeMs, taskid || '', encodeDocUpdatedMember(docRef))
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
