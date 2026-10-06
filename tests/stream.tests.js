import * as t from 'lib0/testing'
import * as promise from 'lib0/promise'
import * as utils from './utils.js'
import * as stream from '../src/stream.js'

/**
 * Older releases stamped `unsafePersistDoc` rows `${ms}-I`, which is not a valid redis stream id.
 *
 * @param {t.TestCase} _tc
 */
export const testSanitizeRedisClock = _tc => {
  t.compare(stream.sanitizeRedisClock('1700000000000-I'), '1700000000000-0')
  t.compare(stream.sanitizeRedisClock('1700000000000-5'), '1700000000000-5')
  t.compare(stream.sanitizeRedisClock('1700000000000'), '1700000000000')
  t.compare(stream.sanitizeRedisClock('0'), '0')
}

/**
 * @param {t.TestCase} _tc
 */
export const testIsSmallerRedisClockLegacySequence = _tc => {
  t.assert(stream.isSmallerRedisClock('5-I', '5-1'))
  t.assert(!stream.isSmallerRedisClock('5-1', '5-I'))
  t.assert(!stream.isSmallerRedisClock('5-I', '5-0') && !stream.isSmallerRedisClock('5-0', '5-I'), '-I compares equal to -0')
  t.assert(stream.isSmallerRedisClock('4-9', '5-I'))
  t.assert(stream.isSmallerRedisClock('5-I', '6-0'))
  t.compare(stream.maxRedisClock('5-I', '5-2'), '5-2')
  t.compare(stream.minRedisClock('5-2', '5-I'), '5-I')
}

/**
 * A legacy `-I` clock that reaches `trimMessages` as `minId` must not crash the trim script. `1` is
 * older than the lifetime window, which forces the script to increment the id.
 *
 * @param {t.TestCase} tc
 */
export const testTrimMessagesLegacyMinId = async tc => {
  const { yhub, defaultDocRef, defaultStream } = await utils.createTestCase(tc)
  const s = yhub.stream
  await s.addMessage(defaultDocRef, { type: 'awareness:v1', update: new Uint8Array([1, 2, 3]) })
  const taskid = /** @type {string} */ ((await s.redis.xRange(s.workerStreamName, '-', '+')).find(e => e.message.compact === defaultStream)?.id)
  t.assert(taskid != null, 'seed produced a pending compact task')
  await s.trimMessages(defaultDocRef, '1-I', 100000, taskid)
  t.assert(await s.redis.xLen(defaultStream) === 1, 'young message survived the trim')
  await utils.waitTasksProcessed(yhub)
}

/**
 * A throw while the subscription loop starts up must not leave `_subRunning` set. Otherwise every
 * later `subscribe` sees a loop that is already running and the process stops delivering stream
 * messages entirely.
 *
 * @param {t.TestCase} tc
 */
export const testSubLoopRestartsAfterConnectFailure = async tc => {
  const { yhub, defaultDocRef } = await utils.createTestCase(tc)
  // a dedicated stream - the shared hub's subscription client is already connected, so it cannot
  // take the failing-connect path anymore
  const st = await stream.createStream(yhub.conf)
  const conf = st.redisClientConf
  // a closed port and no reconnects: `connect()` rejects instead of retrying
  st.redisClientConf = { ...conf, url: 'redis://127.0.0.1:1', socket: { ...conf.socket, reconnectStrategy: false } }
  await t.failsAsync(() => st._runSub())
  t.assert(!st._subRunning, 'a thrown setup error released the loop flag')
  st.redisClientConf = conf
  /**
   * @type {Array<any>}
   */
  const received = []
  const subscriber = {
    lastReceivedClock: '0',
    /**
     * @param {any} _docRef
     * @param {Array<any>} ms
     */
    onStreamMessage: (_docRef, ms) => { received.push(...ms) },
    destroy: () => {},
    closeWithError: () => {}
  }
  st.subscribe(defaultDocRef, subscriber)
  await st.addMessage(defaultDocRef, { type: 'awareness:v1', update: new Uint8Array([1, 2, 3]) })
  await promise.until(10000, () => received.length > 0)
  t.compare(received[0].type, 'awareness:v1')
  st.unsubscribe(defaultDocRef, subscriber)
  await promise.until(5000, () => !st._subRunning)
  st.redisSubscriptions?.destroy()
  st.redis.destroy()
  await utils.waitTasksProcessed(yhub)
}

/**
 * Subscribers at the same clock are handed the same messages array, which is what lets `WSUser`
 * encode a batch once for all of them.
 *
 * @param {t.TestCase} tc
 */
export const testSubscribersShareBatch = async tc => {
  const { yhub, defaultDocRef } = await utils.createTestCase(tc)
  const createSubscriber = () => {
    const subscriber = {
      lastReceivedClock: '0',
      /**
       * @type {Array<any>|null}
       */
      received: null,
      /**
       * @param {any} _docRef
       * @param {Array<any>} ms
       */
      onStreamMessage: (_docRef, ms) => { subscriber.received = ms },
      destroy: () => {},
      closeWithError: () => {}
    }
    return subscriber
  }
  const s1 = createSubscriber()
  const s2 = createSubscriber()
  yhub.stream.subscribe(defaultDocRef, s1)
  yhub.stream.subscribe(defaultDocRef, s2)
  await yhub.stream.addMessage(defaultDocRef, { type: 'awareness:v1', update: new Uint8Array([1, 2, 3]) })
  await promise.until(10000, () => s1.received != null && s2.received != null)
  t.assert(s1.received === s2.received, 'both subscribers received the same array instance')
  yhub.stream.unsubscribe(defaultDocRef, s1)
  yhub.stream.unsubscribe(defaultDocRef, s2)
  await utils.waitTasksProcessed(yhub)
}
