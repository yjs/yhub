import * as Y from '@y/y'
import * as t from 'lib0/testing'
import * as promise from 'lib0/promise'
import * as buffer from 'lib0/buffer'
import * as delta from 'lib0/delta'
import * as types from '../src/types.js'
import * as utils from './utils.js'
import { registerApi } from '../src/api.js'

/**
 * @param {Response} response
 */
const decodeResponse = async response => buffer.decodeAny(new Uint8Array(await response.arrayBuffer()))

// not 9010/9011 - those host ports belong to MinIO (see compose.yaml)
const purposeHubPort = 9012
const purposeHost = `localhost:${purposeHubPort}`

/**
 * The purposes the auth plugin below received, in call order.
 *
 * @type {Array<string|null|undefined>}
 */
const purposeCalls = []

await utils.createTestHub({
  worker: null,
  server: {
    port: purposeHubPort,
    auth: types.createAuthPlugin({
      async readAuthInfo (req) {
        if (req.getHeader('x-no-auth') === '1') return null
        return { userid: 'purposeUser' }
      },
      async getAccessType (_authInfo, _room, purpose) {
        purposeCalls.push(purpose)
        if (purpose === 'admin') return null
        if (purpose === 'comments') return 'rw'
        return 'r'
      }
      // intentionally no getOrgAccessType / getGlobalAccessType - org/global endpoints must deny
    }),
    api: [
      { name: 'purposed', accessPurpose: 'comments', get: async () => ({ ok: true }), post: async () => ({ ok: true }) },
      { name: 'unpurposed', get: async () => ({ ok: true }), post: async () => ({ ok: true }) },
      { name: 'private', accessPurpose: 'admin', get: async () => ({ ok: true }) },
      { name: 'orgless', scope: 'org', get: async () => ({ ok: true }) },
      { name: 'globalless', scope: 'global', get: async () => ({ ok: true }) }
    ]
  }
})

// a hub with a renamed custom-api prefix: endpoints are served under /collaboration/...
// instead of /api/...
const prefixHubPort = 9014
const prefixHost = `localhost:${prefixHubPort}`

await utils.createTestHub({
  worker: null,
  server: {
    port: prefixHubPort,
    apiPrefix: 'collaboration',
    auth: types.createAuthPlugin({
      async readAuthInfo () { return { userid: 'prefixUser' } },
      async getAccessType () { return 'rw' }
    }),
    api: [
      { name: 'echo', get: async req => ({ docid: req.docid }) }
    ]
  }
})

/**
 * @param {t.TestCase} tc
 */
export const testDocScope = async tc => {
  const { org } = await utils.createTestCase(tc)
  const docid = tc.testName + '-doc'
  const res = await fetch(`http://${utils.yhubHost}/api/v1/echo/${org}/${docid}?q=42&branch=b2`, { headers: { 'x-echo': 'hi' } })
  t.assert(res.status === 200)
  t.assert(res.headers.get('content-type') === 'application/x-lib0any')
  const body = await decodeResponse(res)
  t.compare(body.room, { org, docid, branch: 'b2' })
  t.assert(body.org === org && body.docid === docid && body.branch === 'b2')
  t.assert(body.q === '42')
  t.assert(body.userid === 'user1')
  t.assert(body.header === 'hi')
  // branch defaults to main
  const resDefault = await fetch(`http://${utils.yhubHost}/api/v1/echo/${org}/${docid}`)
  t.compare((await decodeResponse(resDefault)).room, { org, docid, branch: 'main' })
}

/**
 * @param {t.TestCase} tc
 */
export const testMethodsAndReturnValues = async tc => {
  const { org } = await utils.createTestCase(tc)
  const base = `http://${utils.yhubHost}/api/v1/echo/${org}/${tc.testName}-doc`
  await t.groupAsync('post: any-encoded body round-trip, bytes() after any()', async () => {
    const reqBody = { a: [1, 'x'], nested: { ok: true } }
    const res = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: /** @type {Uint8Array<ArrayBuffer>} */ (buffer.encodeAny(reqBody)) })
    t.assert(res.status === 200)
    const body = await decodeResponse(res)
    t.compare(body.received, reqBody)
    t.assert(body.rawLen === buffer.encodeAny(reqBody).byteLength)
  })
  await t.groupAsync('put: string responds as text/plain', async () => {
    const res = await fetch(base, { method: 'PUT' })
    t.assert(res.status === 200)
    t.assert(res.headers.get('content-type') === 'text/plain; charset=utf-8')
    t.assert(await res.text() === 'hello')
  })
  await t.groupAsync('patch: Uint8Array responds as-is', async () => {
    const res = await fetch(base, { method: 'PATCH' })
    t.assert(res.status === 200)
    t.assert(res.headers.get('content-type') === 'application/octet-stream')
    t.compare(Array.from(new Uint8Array(await res.arrayBuffer())), [1, 2, 3])
  })
  await t.groupAsync('delete: undefined responds 204 without body', async () => {
    const res = await fetch(base, { method: 'DELETE' })
    t.assert(res.status === 204)
    t.assert((await res.arrayBuffer()).byteLength === 0)
  })
  await t.groupAsync('options preflight advertises all methods and reflects requested headers', async () => {
    const res = await fetch(base, { method: 'OPTIONS', headers: { Origin: 'http://example.com', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-custom-header' } })
    t.assert(res.status === 204)
    const allowed = res.headers.get('access-control-allow-methods') ?? ''
    t.assert(allowed.includes('PUT') && allowed.includes('DELETE') && allowed.includes('PATCH'))
    t.assert(res.headers.get('access-control-allow-headers') === 'x-custom-header')
  })
}

/**
 * @param {t.TestCase} tc
 */
export const testVersioning = async tc => {
  const { org } = await utils.createTestCase(tc)
  const docid = tc.testName + '-doc'
  const resV2 = await fetch(`http://${utils.yhubHost}/api/v2/echo/${org}/${docid}`)
  t.compare(await decodeResponse(resV2), { v: 2 })
  const resV1 = await fetch(`http://${utils.yhubHost}/api/v1/echo/${org}/${docid}`)
  t.assert((await decodeResponse(resV1)).v === undefined)
}

/**
 * @param {t.TestCase} tc
 */
export const testPathParams = async tc => {
  const { org } = await utils.createTestCase(tc)
  const docid = tc.testName + '-doc'
  // the item route shares the collection's name ('echo') - routing is by url depth
  const res = await fetch(`http://${utils.yhubHost}/api/v1/echo/${org}/${docid}/c123`)
  t.compare(await decodeResponse(res), { commentId: 'c123', docid })
}

/**
 * @param {t.TestCase} tc
 */
export const testOrgAndGlobalScope = async tc => {
  const { org } = await utils.createTestCase(tc)
  const orgRes = await fetch(`http://${utils.yhubHost}/api/v1/docs/${org}`)
  t.compare(await decodeResponse(orgRes), { org, room: null, docid: null })
  const globalRes = await fetch(`http://${utils.yhubHost}/api/v1/stats`)
  t.compare(await decodeResponse(globalRes), { ok: true, org: null })
}

/**
 * @param {t.TestCase} tc
 */
export const testResponseReturn = async tc => {
  const { org } = await utils.createTestCase(tc)
  const res = await fetch(`http://${utils.yhubHost}/api/v1/resp/${org}/${tc.testName}-doc`)
  t.assert(res.status === 201)
  t.assert(res.headers.get('content-type') === 'application/json')
  t.assert(res.headers.get('x-test') === 'yes')
  t.assert(res.headers.get('access-control-allow-origin') === '*')
  t.compare(await res.json(), { a: 1 })
}

/**
 * @param {t.TestCase} tc
 */
export const testErrors = async tc => {
  const { org } = await utils.createTestCase(tc)
  const base = `http://${utils.yhubHost}/api/v1/fail/${org}/${tc.testName}-doc`
  await t.groupAsync('apiError produces status + { error, ...extra }', async () => {
    const res = await fetch(base)
    t.assert(res.status === 404)
    t.assert(res.headers.get('content-type') === 'application/x-lib0any')
    t.compare(await decodeResponse(res), { error: 'nope', code: 'not-found' })
  })
  await t.groupAsync('other exceptions produce a generic 500', async () => {
    const res = await fetch(base, { method: 'POST' })
    t.assert(res.status === 500)
    const body = await decodeResponse(res)
    t.assert(body.error === 'Internal server error')
  })
  await t.groupAsync('foreign errors with a status property don\'t leak their message', async () => {
    const res = await fetch(base, { method: 'PUT' })
    t.assert(res.status === 500)
    const body = await decodeResponse(res)
    t.assert(body.error === 'Internal server error')
  })
}

/**
 * @param {t.TestCase} tc
 */
export const testYhubAccess = async tc => {
  const { org, createWsClient } = await utils.createTestCase(tc)
  const { ydoc } = await createWsClient({ waitForSync: true })
  ydoc.get().applyDelta(delta.create().insert('hello api').done())
  await promise.untilAsync(async () => {
    const res = await fetch(`http://${utils.yhubHost}/api/v1/getdoc/${org}/${ydoc.guid}`)
    const { doc } = await decodeResponse(res)
    const yd = new Y.Doc()
    Y.applyUpdate(yd, doc)
    return JSON.stringify(yd.get().toDelta().toJSON()).includes('hello api')
  }, 10000)
}

/**
 * @param {t.TestCase} tc
 */
export const testAbort = async tc => {
  const { org } = await utils.createTestCase(tc)
  utils.apiTestState.slowAborted = null
  const controller = new AbortController()
  const aborted = fetch(`http://${utils.yhubHost}/api/v1/slow/${org}/${tc.testName}-doc`, { signal: controller.signal }).catch(() => null)
  await promise.wait(50)
  controller.abort()
  await aborted
  await promise.wait(500)
  t.assert(utils.apiTestState.slowAborted === true)
  // the server is still healthy and req.aborted is false for an undisturbed request
  const res = await fetch(`http://${utils.yhubHost}/api/v1/slow/${org}/${tc.testName}-doc`)
  t.assert(res.status === 200)
  t.assert(utils.apiTestState.slowAborted === false)
}

/**
 * @param {t.TestCase} _tc
 */
export const testPurposeAndAuth = async _tc => {
  await t.groupAsync('accessPurpose is forwarded, purpose grants rw', async () => {
    purposeCalls.length = 0
    const res = await fetch(`http://${purposeHost}/api/v1/purposed/o/d`)
    t.assert(res.status === 200)
    t.assert(purposeCalls[purposeCalls.length - 1] === 'comments')
    const postRes = await fetch(`http://${purposeHost}/api/v1/purposed/o/d`, { method: 'POST' })
    t.assert(postRes.status === 200)
  })
  await t.groupAsync('unset accessPurpose arrives as null, plain access applies', async () => {
    purposeCalls.length = 0
    const res = await fetch(`http://${purposeHost}/api/v1/unpurposed/o/d`)
    t.assert(res.status === 200)
    t.assert(purposeCalls[purposeCalls.length - 1] === null)
    const postRes = await fetch(`http://${purposeHost}/api/v1/unpurposed/o/d`, { method: 'POST' })
    t.assert(postRes.status === 403)
  })
  await t.groupAsync('purpose-private endpoint denies', async () => {
    const res = await fetch(`http://${purposeHost}/api/v1/private/o/d`)
    t.assert(res.status === 403)
  })
  await t.groupAsync('org/global scope without the auth callback fails closed', async () => {
    const orgRes = await fetch(`http://${purposeHost}/api/v1/orgless/o`)
    t.assert(orgRes.status === 403)
    const globalRes = await fetch(`http://${purposeHost}/api/v1/globalless`)
    t.assert(globalRes.status === 403)
  })
  await t.groupAsync('failed readAuthInfo responds 401', async () => {
    const res = await fetch(`http://${purposeHost}/api/v1/unpurposed/o/d`, { headers: { 'x-no-auth': '1' } })
    t.assert(res.status === 401)
  })
}

/**
 * @param {t.TestCase} tc
 */
export const testCustomApiPrefix = async tc => {
  await utils.createTestCase(tc)
  const docid = tc.testName + '-doc'
  const res = await fetch(`http://${prefixHost}/collaboration/v1/echo/testOrg/${docid}`)
  t.assert(res.status === 200)
  t.assert((await decodeResponse(res)).docid === docid)
  // the default prefix is not served on this hub
  const apiFailed = await fetch(`http://${prefixHost}/api/v1/echo/testOrg/${docid}`).then(res => !res.ok, () => true)
  t.assert(apiFailed, 'endpoints must not also be served under the default prefix')
}

/**
 * @param {t.TestCase} _tc
 */
export const testSpecValidation = _tc => {
  /**
   * @type {Array<string>}
   */
  const patterns = []
  /**
   * @type {any}
   */
  const stubApp = { get: (/** @type {string} */ p) => { patterns.push(p); return stubApp }, post: () => stubApp, put: () => stubApp, patch: () => stubApp, del: () => stubApp }
  /**
   * @param {Array<any>} api
   * @param {string} [apiPrefix]
   * @return {any}
   */
  const fakeYhub = (api, apiPrefix) => ({ conf: { server: { auth: null, api, apiPrefix } } })
  const handler = async () => ({})
  // valid baseline
  registerApi(fakeYhub([{ name: 'a', get: handler }]), stubApp)
  t.assert(patterns[0] === '/api/v1/a/:org/:docid')
  // same name under a different version is fine
  registerApi(fakeYhub([{ name: 'a', get: handler }, { name: 'a', version: 'v2', get: handler }]), stubApp)
  // same name at a different url depth is fine (collection + item)
  registerApi(fakeYhub([{ name: 'a', get: handler }, { name: 'a', path: '/:id', get: handler }]), stubApp)
  // duplicate (name, version) at the same url depth
  t.fails(() => registerApi(fakeYhub([{ name: 'a', get: handler }, { name: 'a', version: 'v1', get: handler }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', path: '/:x', get: handler }, { name: 'a', path: '/:y', get: handler }]), stubApp))
  // scope params count towards depth: doc-scope collides with org-scope + one path param
  t.fails(() => registerApi(fakeYhub([{ name: 'a', get: handler }, { name: 'a', scope: 'org', path: '/:id', get: handler }]), stubApp))
  // name must be a single segment
  t.fails(() => registerApi(fakeYhub([{ name: 'a/b', get: handler }]), stubApp))
  // name is required, version and accessPurpose must be strings
  t.fails(() => registerApi(fakeYhub([{ get: handler }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', version: 2, get: handler }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', accessPurpose: 42, get: handler }]), stubApp))
  // at least one method handler
  t.fails(() => registerApi(fakeYhub([{ name: 'a' }]), stubApp))
  // invalid scope
  t.fails(() => registerApi(fakeYhub([{ name: 'a', scope: 'world', get: handler }]), stubApp))
  // path params: named only, unique, org/docid/branch reserved
  t.fails(() => registerApi(fakeYhub([{ name: 'a', path: '/static', get: handler }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', path: '/:org', get: handler }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', path: '/:branch', get: handler }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', path: '/:x/:x', get: handler }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', path: ':x', get: handler }]), stubApp))
  // configurable prefix: served under the renamed segment
  patterns.length = 0
  registerApi(fakeYhub([{ name: 'a', get: handler }], 'collaboration'), stubApp)
  t.assert(patterns[0] === '/collaboration/v1/a/:org/:docid')
  // the prefix must be a single bare segment that doesn't collide with built-in routes
  t.fails(() => registerApi(fakeYhub([{ name: 'a', get: handler }], 'my/api'), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', get: handler }], '/collaboration'), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', get: handler }], ''), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', get: handler }], 'ydoc'), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', get: handler }], 'ws'), stubApp))
}
