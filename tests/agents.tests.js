import * as t from 'lib0/testing'
import * as promise from 'lib0/promise'
import * as Y from '@y/y'
import * as delta from 'lib0/delta'
import * as utils from './utils.js'

/**
 * Wait until `cond()` returns truthy or `timeoutMs` elapses; throws on timeout.
 * @param {() => boolean} cond
 * @param {number} [timeoutMs]
 */
const waitFor = (cond, timeoutMs = 3000) => promise.until(timeoutMs, cond)

/**
 * Agent text edits inside the handler are streamed to connected clients with
 * the supplied `author` recorded as the primary attribution.
 *
 * @param {t.TestCase} tc
 */
export const testAgentUpdatesPropagate = async tc => {
  const { createWsClient, yhub, defaultRoom } = await utils.createTestCase(tc)
  const { ydoc: clientDoc } = await createWsClient({ waitForSync: true })
  await yhub.agentTask(defaultRoom, { author: 'claude' }, async (ydoc) => {
    ydoc.get().applyDelta(delta.create().insert('hello world').done())
  })
  await waitFor(() => clientDoc.get().toDelta().childCnt === 11)
  t.compare(clientDoc.get().toDelta(), delta.create(delta.$deltaAny).insert('hello world'))
}

/**
 * When only `author` is supplied, the agent's awareness is pre-seeded with
 * `{ user: { name: author } }` and other clients see that name. When
 * `displayedAuthor` is provided it takes precedence, but never leaks into the
 * content attribution.
 *
 * @param {t.TestCase} tc
 */
export const testDisplayedAuthor = async tc => {
  const { createWsClient, yhub, defaultRoom } = await utils.createTestCase(tc)
  const { provider } = await createWsClient({ waitForSync: true })
  let agentCid = 0
  // displayedAuthor falls back to author when omitted
  await yhub.agentTask(defaultRoom, { author: 'claude', clearAwareness: false }, async (_ydoc, aw) => {
    agentCid = aw.clientID
    // Give the awareness message time to round-trip via Redis to the client.
    await waitFor(() => provider.awareness.states.get(agentCid)?.user?.name === 'claude')
  })
  // displayedAuthor overrides
  let agentCid2 = 0
  await yhub.agentTask(defaultRoom, { author: 'claude', displayedAuthor: 'Claude', clearAwareness: false }, async (_ydoc, aw) => {
    agentCid2 = aw.clientID
    await waitFor(() => provider.awareness.states.get(agentCid2)?.user?.name === 'Claude')
  })
  t.assert(agentCid !== 0 && agentCid2 !== 0, 'captured both agent client IDs')
}

/**
 * With the default `clearAwareness: 0`, the agent's awareness disconnect is
 * broadcast before the returned promise resolves. (We still wait a beat for the
 * disconnect to round-trip back to the observing client.)
 *
 * @param {t.TestCase} tc
 */
export const testClearAwarenessImmediate = async tc => {
  const { createWsClient, yhub, defaultRoom } = await utils.createTestCase(tc)
  const { provider } = await createWsClient({ waitForSync: true })
  let agentCid = 0
  await yhub.agentTask(defaultRoom, { author: 'claude' }, async (_ydoc, aw) => {
    agentCid = aw.clientID
    await waitFor(() => provider.awareness.states.has(agentCid))
  })
  await waitFor(() => !provider.awareness.states.has(agentCid))
  const meta = provider.awareness.meta.get(agentCid)
  t.assert(meta != null && meta.clock >= 2, 'disconnect bumped the awareness clock')
}

/**
 * With `clearAwareness: <seconds>` the agent stays present for roughly that
 * many seconds after the handler resolves, and the returned promise resolves
 * only after the disconnect has been sent.
 *
 * @param {t.TestCase} tc
 */
export const testClearAwarenessDelayed = async tc => {
  const { createWsClient, yhub, defaultRoom } = await utils.createTestCase(tc)
  const { provider } = await createWsClient({ waitForSync: true })
  let agentCid = 0
  let handlerExitedAt = 0
  const task = yhub.agentTask(defaultRoom, { author: 'claude', clearAwareness: 0.4 }, async (_ydoc, aw) => {
    agentCid = aw.clientID
    await waitFor(() => provider.awareness.states.has(agentCid))
    handlerExitedAt = Date.now()
  })
  await task
  const elapsed = Date.now() - handlerExitedAt
  t.assert(elapsed >= 350, `promise resolved after ~${elapsed}ms (>=350)`)
  await waitFor(() => !provider.awareness.states.has(agentCid))
}

/**
 * `clearAwareness: false` leaves the agent's awareness state in place on
 * success; the caller takes over the agent's awareness lifecycle.
 *
 * @param {t.TestCase} tc
 */
export const testClearAwarenessFalse = async tc => {
  const { createWsClient, yhub, defaultRoom } = await utils.createTestCase(tc)
  const { provider } = await createWsClient({ waitForSync: true })
  let agentCid = 0
  await yhub.agentTask(defaultRoom, { author: 'claude', clearAwareness: false }, async (_ydoc, aw) => {
    agentCid = aw.clientID
    await waitFor(() => provider.awareness.states.has(agentCid))
  })
  // Give any (incorrect) cleanup a chance to arrive — it should not.
  await promise.wait(200)
  t.assert(provider.awareness.states.has(agentCid), 'agent awareness persists')
}

/**
 * Handler errors propagate to the caller. Awareness is cleared immediately
 * regardless of `clearAwareness`, so the agent isn't left as a ghost cursor.
 *
 * @param {t.TestCase} tc
 */
export const testErrorClearsImmediatelyAndRejects = async tc => {
  const { createWsClient, yhub, defaultRoom } = await utils.createTestCase(tc)
  const { provider } = await createWsClient({ waitForSync: true })
  let agentCid = 0
  const startedAt = Date.now()
  /** @type {Error | null} */
  let caught = null
  try {
    await yhub.agentTask(defaultRoom, { author: 'claude', clearAwareness: 5 }, async (_ydoc, aw) => {
      agentCid = aw.clientID
      await waitFor(() => provider.awareness.states.has(agentCid))
      throw new Error('boom')
    })
  } catch (err) {
    caught = /** @type {Error} */ (err)
  }
  const elapsed = Date.now() - startedAt
  t.assert(caught != null && caught.message === 'boom', 'error forwarded to caller')
  t.assert(elapsed < 4000, `cleared without waiting full 5s delay (took ${elapsed}ms)`)
  await waitFor(() => !provider.awareness.states.has(agentCid))
}

/**
 * Attribution: `author` flows into the `insert` content attribute, `promptBy`
 * and entries from `customAttributions` flow into `insert:${k}`. `displayedAuthor` is
 * never recorded in the contentmap.
 *
 * @param {t.TestCase} tc
 */
export const testAttributionRecorded = async tc => {
  const { yhub, defaultRoom } = await utils.createTestCase(tc)
  await yhub.agentTask(defaultRoom, {
    author: 'claude-id-42',
    displayedAuthor: 'Claude',
    promptBy: 'kevin',
    customAttributions: [{ k: 'source', v: 'agent-v1' }, { k: 'model', v: 'opus-4.7' }]
  }, async (ydoc) => {
    ydoc.get().applyDelta(delta.create().insert('hello').done())
  })
  const { nongcDoc, contentmap } = await yhub.getDoc(defaultRoom, { nongc: true, contentmap: true })
  t.assert(nongcDoc != null && contentmap != null, 'fetched doc + contentmap')
  const verify = new Y.Doc()
  Y.applyUpdate(verify, /** @type {Uint8Array} */ (nongcDoc))
  const attributions = Y.decodeContentMap(/** @type {Uint8Array} */ (contentmap))
  const rendered = verify.get().toDelta(new Y.TwosetAttributionManager(Y.diffIdMap(attributions.inserts, attributions.deletes), Y.createIdMap()))
  const op = delta.$textOp.cast(rendered.children.start)
  const attr = /** @type {Record<string, any> | null | undefined} */ (op.attribution)
  console.log('rendered attribution', JSON.stringify(attr))
  // `insert` is multi-valued (array) by Y.TwosetAttributionManager convention;
  // custom attribution keys like `insert:promptBy` are rendered as the raw value.
  /**
   * @param {string} key
   * @param {string} expected
   */
  const hasAttr = (key, expected) => {
    const v = attr?.[key]
    return v === expected || (Array.isArray(v) && v.includes(expected))
  }
  t.assert(hasAttr('insert', 'claude-id-42'), 'author recorded as insert attribution')
  t.assert(hasAttr('insert:promptBy', 'kevin'), 'promptBy recorded as insert:promptBy')
  t.assert(hasAttr('insert:source', 'agent-v1'), 'customAttributions.source recorded')
  t.assert(hasAttr('insert:model', 'opus-4.7'), 'customAttributions.model recorded')
  // displayedAuthor must not leak — assert no attribute value equals 'Claude'.
  const allValues = JSON.stringify(attr) ?? ''
  t.assert(allValues.indexOf('"Claude"') < 0, 'displayedAuthor not present in contentmap')
}

/**
 * The ydoc passed to the handler is hydrated from the room's current state.
 *
 * @param {t.TestCase} tc
 */
export const testSnapshotHydration = async tc => {
  const { createWsClient, yhub, defaultRoom } = await utils.createTestCase(tc)
  const { ydoc: seedDoc } = await createWsClient({ waitForSync: true })
  seedDoc.get().applyDelta(delta.create().insert('AB').done())
  await promise.wait(200)
  /** @type {any} */
  let seen
  await yhub.agentTask(defaultRoom, { author: 'claude' }, async (ydoc) => {
    seen = ydoc.get().toDelta()
  })
  t.compare(seen, delta.create(delta.$deltaAny).insert('AB'))
}
