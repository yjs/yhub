import * as Y from '@y/y'
import * as t from 'lib0/testing'
import * as promise from 'lib0/promise'
import * as buffer from 'lib0/buffer'
import * as delta from 'lib0/delta'
import * as s from 'lib0/schema'
import * as types from '../src/types.js'
import * as utils from './utils.js'
import { apiError, registerApi } from '../src/api.js'

/**
 * @param {Response} response
 */
const decodeResponse = async response => buffer.decodeAny(new Uint8Array(await response.arrayBuffer()))

const endpointHubPort = utils.testHubPort(3)
const endpointHost = `localhost:${endpointHubPort}`

/**
 * The (type, resourceId) selectors the auth plugin below received, in call order.
 *
 * @type {Array<{ type: string, resourceId: object }>}
 */
const permissionCalls = []

await utils.createTestHub({
  worker: null,
  server: {
    port: endpointHubPort,
    auth: types.createAuthPlugin({
      async authenticate (req) {
        // a branded 401 is the plugin rejecting a credential; null is an anonymous caller
        if (req.getHeader('x-no-auth') === '1') throw apiError(401, 'unauthenticated')
        if (req.getHeader('x-anon') === '1') return null
        return { userid: 'endpointUser' }
      },
      // org/global endpoints fail closed: scopes without a handler deny
      authorize: types.createAuthorize({
        document: async (resourceId) => {
          permissionCalls.push({ type: 'document', resourceId })
          return {
            type: 'permissions:document:v1',
            endpoint: { '*': '-r--', comments: 'crud', appendonly: 'c---', blocked: false }
          }
        }
      })
    }),
    api: [
      { name: 'comments', get: { handler: async () => ({ ok: true }) }, post: { handler: async () => ({ ok: true }) } },
      { name: 'appendonly', get: { handler: async () => ({ ok: true }) }, post: { handler: async () => ({ ok: true }) } },
      { name: 'fallback', get: { handler: async () => ({ ok: true }) }, post: { handler: async () => ({ ok: true }) } },
      { name: 'whoami', get: { handler: async req => ({ authInfo: req.authInfo }) } },
      { name: 'blocked', get: { $query: s.$partial({ n: s.$number }), handler: async () => ({ ok: true }) } },
      { name: 'orgless', scope: 'org', get: { handler: async () => ({ ok: true }) } },
      { name: 'globalless', scope: 'global', get: { handler: async () => ({ ok: true }) } },
      // prebuilt (partial) schema spec + auth-before-validation ordering (see testQuerySchema)
      { name: 'qcheck', get: { $query: s.$partial({ n: s.$number }), handler: async req => req.query } }
    ]
  }
})

// a hub with a renamed custom-api prefix: endpoints are served under /collaboration/...
// instead of /api/...
const prefixHubPort = utils.testHubPort(4)
const prefixHost = `localhost:${prefixHubPort}`

await utils.createTestHub({
  worker: null,
  server: {
    port: prefixHubPort,
    apiPrefix: 'collaboration',
    auth: types.createAuthPlugin({
      async authenticate () { return { userid: 'prefixUser' } },
      authorize: types.createAuthorize({
        document: async () => ({ type: 'permissions:document:v1', ydoc: 'cru-', endpoint: { '*': 'crud' } })
      })
    }),
    api: [
      { name: 'echo', get: { handler: async req => ({ docid: req.docid }) } }
    ]
  }
})

/**
 * @param {t.TestCase} tc
 */
export const testDocScope = async tc => {
  const { org } = await utils.createTestCase(tc)
  const docid = tc.testName + '-doc'
  const res = await fetch(`http://${utils.yhubHost}/api/echo/v1/${org}/${docid}?q=42&branch=b2`, { headers: { 'x-echo': 'hi' } })
  t.assert(res.status === 200)
  t.assert(res.headers.get('content-type') === 'application/x-lib0any')
  const body = await decodeResponse(res)
  t.compare(body.docRef, { org, docid, branch: 'b2' })
  t.assert(body.org === org && body.docid === docid && body.branch === 'b2')
  t.assert(body.q === '42')
  t.assert(body.userid === 'user1')
  t.assert(body.header === 'hi')
  // branch defaults to main
  const resDefault = await fetch(`http://${utils.yhubHost}/api/echo/v1/${org}/${docid}`)
  t.compare((await decodeResponse(resDefault)).docRef, { org, docid, branch: 'main' })
}

/**
 * @param {t.TestCase} tc
 */
export const testMethodsAndReturnValues = async tc => {
  const { org } = await utils.createTestCase(tc)
  const base = `http://${utils.yhubHost}/api/echo/v1/${org}/${tc.testName}-doc`
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
  await t.groupAsync('options preflight advertises the endpoint\'s methods and the configured headers', async () => {
    const res = await fetch(base, { method: 'OPTIONS', headers: { Origin: 'http://example.com', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-custom-header' } })
    t.assert(res.status === 204)
    const allowed = res.headers.get('access-control-allow-methods') ?? ''
    t.assert(allowed.includes('PUT') && allowed.includes('DELETE') && allowed.includes('PATCH'))
    // the requested headers are no longer reflected - the configured set is authoritative.
    // this hub sets neither allowHeaders nor maxAge, so both come from the defaults
    t.assert(res.headers.get('access-control-allow-headers') === 'Content-Type, Authorization')
    t.assert(res.headers.get('access-control-max-age') === '3600')
  })
}

/**
 * @param {t.TestCase} tc
 */
export const testVersioning = async tc => {
  const { org } = await utils.createTestCase(tc)
  const docid = tc.testName + '-doc'
  const resV2 = await fetch(`http://${utils.yhubHost}/api/echo/v2/${org}/${docid}`)
  t.compare(await decodeResponse(resV2), { v: 2 })
  const resV1 = await fetch(`http://${utils.yhubHost}/api/echo/v1/${org}/${docid}`)
  t.assert((await decodeResponse(resV1)).v === undefined)
}

/**
 * @param {t.TestCase} tc
 */
export const testPathParams = async tc => {
  const { org } = await utils.createTestCase(tc)
  const docid = tc.testName + '-doc'
  // the item route shares the collection's name ('echo') - routing is by url depth
  const res = await fetch(`http://${utils.yhubHost}/api/echo/v1/${org}/${docid}/c123`)
  t.compare(await decodeResponse(res), { commentId: 'c123', docid })
}

/**
 * @param {t.TestCase} tc
 */
export const testQuerySchema = async tc => {
  const { org } = await utils.createTestCase(tc)
  const base = `http://${utils.yhubHost}/api/typedq/v1/${org}/${tc.testName}-doc`
  await t.groupAsync('declared attrs are coerced, undeclared pass through as raw strings', async () => {
    const res = await fetch(`${base}?limit=42&active=true&extra=7&mode=a&page=2&lit=x&mixed=false`)
    t.assert(res.status === 200)
    const body = await decodeResponse(res)
    t.compare(body.query, { limit: 42, active: true, extra: '7', mode: 'a', page: 2, lit: 'x', mixed: false })
    t.assert(body.isNumber === true)
  })
  await t.groupAsync('number forms and union branches', async () => {
    const res = await fetch(`${base}?limit=-4.5&mixed=3&mode=b&page=1&lit=x`)
    const body = await decodeResponse(res)
    t.assert(body.query.limit === -4.5)
    t.assert(body.query.mixed === 3)
    // s.coerce numbers follow Number() semantics
    const resExp = await fetch(`${base}?limit=1e3&mode=a&page=1&lit=x`)
    t.assert((await decodeResponse(resExp)).query.limit === 1000)
  })
  await t.groupAsync('missing required attribute responds 400', async () => {
    const res = await fetch(base)
    t.assert(res.status === 400)
    t.compare(await decodeResponse(res), { error: 'invalid query: [limit] undefined doesn\'t match number', code: 'invalid-query' })
  })
  await t.groupAsync('invalid attributes respond 400 naming the attribute', async () => {
    for (const [query, errMsg] of /** @type {Array<[string, string]>} */ ([
      ['limit=abc', '[limit] "abc" doesn\'t match number'],
      ['limit=', '[limit] "" doesn\'t match number'],
      ['limit=1&active=1', '[active] "1" doesn\'t match boolean'],
      ['limit=1&mode=c', '[mode] "c" doesn\'t match a | b'],
      ['limit=1&page=3', '[page] "3" doesn\'t match 1 | 2'],
      ['limit=1&lit=y', '[lit] "y" doesn\'t match x']
    ])) {
      // base pairs keep the required mode/page/lit valid; a case's own pair wins (last-wins)
      const res = await fetch(`${base}?mode=a&page=1&lit=x&${query}`)
      t.assert(res.status === 400, `?${query} must fail`)
      t.compare(await decodeResponse(res), { error: `invalid query: ${errMsg}`, code: 'invalid-query' })
    }
  })
  await t.groupAsync('$query is per-method: post has none, values stay raw', async () => {
    const res = await fetch(`${base}?limit=abc`, { method: 'POST' })
    t.assert(res.status === 200)
    t.assert((await decodeResponse(res)).raw.limit === 'abc')
  })
  await t.groupAsync('repeated keys: last wins, also for the routing branch', async () => {
    const res = await fetch(`${base}?limit=1&limit=2&mode=a&page=1&lit=x&branch=b1&branch=b2`)
    const body = await decodeResponse(res)
    t.assert(body.query.limit === 2)
    // req.branch and req.query.branch must agree on the same occurrence
    t.assert(body.branch === 'b2')
    t.assert(body.query.branch === 'b2')
  })
  await t.groupAsync('branch keeps its routing meaning and passes through undeclared', async () => {
    const res = await fetch(`${base}?limit=1&branch=b2&mode=a&page=1&lit=x`)
    const body = await decodeResponse(res)
    t.assert(body.branch === 'b2')
    t.assert(body.query.branch === 'b2')
  })
  await t.groupAsync('a declared branch attribute constrains the requested branch', async () => {
    const branchedBase = `http://${utils.yhubHost}/api/branched/v1/${org}/${tc.testName}-doc`
    // ?branch omitted: the server default 'main' is materialized and validated
    t.compare(await decodeResponse(await fetch(branchedBase)), { branch: 'main', qbranch: 'main' })
    t.compare(await decodeResponse(await fetch(`${branchedBase}?branch=b2`)), { branch: 'b2', qbranch: 'b2' })
    const invalid = await fetch(`${branchedBase}?branch=x`)
    t.assert(invalid.status === 400)
    t.assert((await decodeResponse(invalid)).code === 'invalid-query')
  })
  await t.groupAsync('prebuilt s.$object(..).partial spec: attrs optional, still coerced+validated', async () => {
    const absent = await fetch(`http://${endpointHost}/api/qcheck/v1/o/d`)
    t.assert(absent.status === 200)
    t.compare(await decodeResponse(absent), {})
    const coerced = await fetch(`http://${endpointHost}/api/qcheck/v1/o/d?n=5`)
    t.compare(await decodeResponse(coerced), { n: 5 })
    const invalid = await fetch(`http://${endpointHost}/api/qcheck/v1/o/d?n=abc`)
    t.assert(invalid.status === 400)
  })
  await t.groupAsync('auth is decided before query validation', async () => {
    const unauthedRes = await fetch(`http://${endpointHost}/api/qcheck/v1/o/d?n=abc`, { headers: { 'x-no-auth': '1' } })
    t.assert(unauthedRes.status === 401)
    const authedRes = await fetch(`http://${endpointHost}/api/qcheck/v1/o/d?n=abc`)
    t.assert(authedRes.status === 400)
    // an anonymous caller is authorized like any other and reaches validation
    const anonRes = await fetch(`http://${endpointHost}/api/qcheck/v1/o/d?n=abc`, { headers: { 'x-anon': '1' } })
    t.assert(anonRes.status === 400)
  })
}

/**
 * @param {t.TestCase} tc
 */
export const testOrgAndGlobalScope = async tc => {
  const { org } = await utils.createTestCase(tc)
  const orgRes = await fetch(`http://${utils.yhubHost}/api/docs/v1/${org}`)
  t.compare(await decodeResponse(orgRes), { org, docRef: null, docid: null })
  const globalRes = await fetch(`http://${utils.yhubHost}/api/stats/v1`)
  t.compare(await decodeResponse(globalRes), { ok: true, org: null })
}

/**
 * @param {t.TestCase} tc
 */
export const testResponseReturn = async tc => {
  const { org } = await utils.createTestCase(tc)
  const res = await fetch(`http://${utils.yhubHost}/api/resp/v1/${org}/${tc.testName}-doc`)
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
  const base = `http://${utils.yhubHost}/api/fail/v1/${org}/${tc.testName}-doc`
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
export const testJsonResponses = async tc => {
  const { org } = await utils.createTestCase(tc)
  const base = `http://${utils.yhubHost}/api`
  const doc = `${org}/${tc.testName}-doc`
  const acceptJson = { headers: { Accept: 'application/json' } }
  await t.groupAsync('object results serve json on Accept: application/json', async () => {
    const res = await fetch(`${base}/echo/v1/${doc}?q=42`, acceptJson)
    t.assert(res.status === 200)
    t.assert(res.headers.get('content-type') === 'application/json')
    const body = await res.json()
    t.assert(body.q === '42' && body.docid === `${tc.testName}-doc`)
  })
  await t.groupAsync('Accept: */* keeps the lib0-any default', async () => {
    const res = await fetch(`${base}/echo/v1/${doc}`, { headers: { Accept: '*/*' } })
    t.assert(res.headers.get('content-type') === 'application/x-lib0any')
  })
  await t.groupAsync('binary → base64, Date → epoch millis, undefined → null with the key preserved', async () => {
    const res = await fetch(`${base}/jsonshape/v1/${doc}`, acceptJson)
    const body = await res.json()
    t.compare(Array.from(buffer.fromBase64(body.bin)), [1, 2, 254])
    t.compare(Array.from(buffer.fromBase64(body.buf)), [4, 5])
    t.assert(body.when === 1700000000000)
    t.assert('missing' in body && body.missing === null)
    t.compare(Array.from(buffer.fromBase64(body.nested.deep)), [9])
    t.compare(Array.from(buffer.fromBase64(body.list[0])), [7])
  })
  await t.groupAsync('encodedAny: x-lib0any by default, transcoded to json on request', async () => {
    const res = await fetch(`${base}/preenc/v1/${doc}`)
    t.assert(res.headers.get('content-type') === 'application/x-lib0any')
    const body = await decodeResponse(res)
    t.assert(body.a === 1)
    t.compare(Array.from(body.bin), [1, 2])
    const jsonRes = await fetch(`${base}/preenc/v1/${doc}`, acceptJson)
    t.assert(jsonRes.headers.get('content-type') === 'application/json')
    const jsonBody = await jsonRes.json()
    t.assert(jsonBody.a === 1)
    t.compare(Array.from(buffer.fromBase64(jsonBody.bin)), [1, 2])
  })
  await t.groupAsync('strings, raw bytes, Response, and 204 ignore the Accept preference', async () => {
    const putRes = await fetch(`${base}/echo/v1/${doc}`, { method: 'PUT', ...acceptJson })
    t.assert(putRes.headers.get('content-type') === 'text/plain; charset=utf-8')
    const patchRes = await fetch(`${base}/echo/v1/${doc}`, { method: 'PATCH', ...acceptJson })
    t.assert(patchRes.headers.get('content-type') === 'application/octet-stream')
    const respRes = await fetch(`${base}/resp/v1/${doc}`, acceptJson)
    t.assert(respRes.status === 201)
    const delRes = await fetch(`${base}/echo/v1/${doc}`, { method: 'DELETE', ...acceptJson })
    t.assert(delRes.status === 204)
  })
  await t.groupAsync('errors serve json on request', async () => {
    const res = await fetch(`${base}/fail/v1/${doc}`, acceptJson)
    t.assert(res.status === 404)
    t.assert(res.headers.get('content-type') === 'application/json')
    t.compare(await res.json(), { error: 'nope', code: 'not-found' })
    const queryRes = await fetch(`${base}/typedq/v1/${doc}`, acceptJson)
    t.assert(queryRes.status === 400)
    t.assert(queryRes.headers.get('content-type') === 'application/json')
    t.assert((await queryRes.json()).code === 'invalid-query')
  })
}

/**
 * @param {t.TestCase} tc
 */
export const testBodySchema = async tc => {
  const { org } = await utils.createTestCase(tc)
  const base = `http://${utils.yhubHost}/api/typedb/v1/${org}/${tc.testName}-doc`
  const data = new Uint8Array([1, 2, 250])
  await t.groupAsync('lib0-any bodies pass through', async () => {
    const res = await fetch(base, { method: 'POST', body: /** @type {Uint8Array<ArrayBuffer>} */ (buffer.encodeAny({ data })) })
    t.assert(res.status === 200)
    const body = await decodeResponse(res)
    t.assert(body.isU8 === true)
    t.compare(Array.from(body.data), Array.from(data))
    t.assert(body.note === null)
  })
  await t.groupAsync('json bodies: base64 strings coerce to Uint8Array', async () => {
    const res = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: buffer.toBase64(data), note: 'x' }) })
    t.assert(res.status === 200)
    const body = await decodeResponse(res)
    t.assert(body.isU8 === true)
    t.compare(Array.from(body.data), Array.from(data))
    t.assert(body.note === 'x')
  })
  await t.groupAsync('full json round-trip', async () => {
    const res = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ data: buffer.toBase64(data) }) })
    t.assert(res.headers.get('content-type') === 'application/json')
    const body = await res.json()
    t.assert(body.isU8 === true)
    t.compare(Array.from(buffer.fromBase64(body.data)), Array.from(data))
  })
  await t.groupAsync('lib0 bodies are validated, never coerced', async () => {
    // a base64 string for a $uint8Array field is a json affordance - in a lib0 body it is a type error
    const res = await fetch(base, { method: 'POST', body: /** @type {Uint8Array<ArrayBuffer>} */ (buffer.encodeAny({ data: buffer.toBase64(data) })) })
    t.assert(res.status === 400)
    t.compare(await decodeResponse(res), { error: 'invalid body', code: 'invalid-body' })
  })
  await t.groupAsync('malformed bodies respond 400 invalid-body', async () => {
    const malformedJson = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })
    t.assert(malformedJson.status === 400)
    t.compare(await decodeResponse(malformedJson), { error: 'invalid body', code: 'invalid-body' })
    // without the json content type the bytes must be lib0-any - json text is not
    const wrongEncoding = await fetch(base, { method: 'POST', body: JSON.stringify({ data: buffer.toBase64(data) }) })
    t.assert(wrongEncoding.status === 400)
    t.assert((await decodeResponse(wrongEncoding)).code === 'invalid-body')
    const badB64 = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'not!base64' }) })
    t.assert(badB64.status === 400)
    const badB64Body = await decodeResponse(badB64)
    t.assert(badB64Body.code === 'invalid-body')
    t.assert(badB64Body.error.includes('[data]'))
    const missing = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    t.assert(missing.status === 400)
    // the error body is json when the request asked for json
    const jsonErr = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{' })
    t.assert(jsonErr.headers.get('content-type') === 'application/json')
    t.compare(await jsonErr.json(), { error: 'invalid body', code: 'invalid-body' })
  })
  await t.groupAsync('no $body: req.body is undefined, raw accessors remain', async () => {
    const reqBody = { any: ['x'] }
    const res = await fetch(base, { method: 'PATCH', body: /** @type {Uint8Array<ArrayBuffer>} */ (buffer.encodeAny(reqBody)) })
    const body = await decodeResponse(res)
    t.assert(body.bodyIsUndefined === true)
    t.compare(body.received, reqBody)
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
    const res = await fetch(`http://${utils.yhubHost}/api/getdoc/v1/${org}/${ydoc.guid}`)
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
  const aborted = fetch(`http://${utils.yhubHost}/api/slow/v1/${org}/${tc.testName}-doc`, { signal: controller.signal }).catch(() => null)
  await promise.wait(50)
  controller.abort()
  await aborted
  await promise.wait(500)
  t.assert(utils.apiTestState.slowAborted === true)
  // the server is still healthy and req.aborted is false for an undisturbed request
  const res = await fetch(`http://${utils.yhubHost}/api/slow/v1/${org}/${tc.testName}-doc`)
  t.assert(res.status === 200)
  t.assert(utils.apiTestState.slowAborted === false)
}

/**
 * @param {t.TestCase} _tc
 */
export const testEndpointFacetAndAuth = async _tc => {
  await t.groupAsync('a named grant wins over the fallback, and the selector reaches the plugin', async () => {
    permissionCalls.length = 0
    const res = await fetch(`http://${endpointHost}/api/comments/v1/o/d`)
    t.assert(res.status === 200)
    t.compare(permissionCalls[permissionCalls.length - 1], { type: 'document', resourceId: { org: 'o', docid: 'd', branch: 'main' } })
    const postRes = await fetch(`http://${endpointHost}/api/comments/v1/o/d`, { method: 'POST' })
    t.assert(postRes.status === 200)
  })
  await t.groupAsync("the '*' fallback applies to unnamed endpoints - read-only here", async () => {
    const res = await fetch(`http://${endpointHost}/api/fallback/v1/o/d`)
    t.assert(res.status === 200)
    // post checks the 'c' position, which the '-r--' fallback denies
    const postRes = await fetch(`http://${endpointHost}/api/fallback/v1/o/d`, { method: 'POST' })
    t.assert(postRes.status === 403)
  })
  await t.groupAsync('append-only: create without read', async () => {
    const postRes = await fetch(`http://${endpointHost}/api/appendonly/v1/o/d`, { method: 'POST' })
    t.assert(postRes.status === 200)
    const res = await fetch(`http://${endpointHost}/api/appendonly/v1/o/d`)
    t.assert(res.status === 403)
  })
  await t.groupAsync('an explicit denial blocks the fallback, the 403 names the missing permission', async () => {
    const res = await fetch(`http://${endpointHost}/api/blocked/v1/o/d`)
    t.assert(res.status === 403)
    const body = await decodeResponse(res)
    t.assert(body.code === 'missing-permission')
    t.compare(body.required, { type: 'permissions:document:v1', endpoint: { blocked: '-r--' } })
  })
  await t.groupAsync('permissions are decided before query validation', async () => {
    const res = await fetch(`http://${endpointHost}/api/blocked/v1/o/d?n=abc`)
    t.assert(res.status === 403, 'a denied caller must not learn about query validity')
  })
  await t.groupAsync('org/global scope fails closed on a null answer', async () => {
    const orgRes = await fetch(`http://${endpointHost}/api/orgless/v1/o`)
    t.assert(orgRes.status === 403)
    const globalRes = await fetch(`http://${endpointHost}/api/globalless/v1`)
    t.assert(globalRes.status === 403)
  })
  await t.groupAsync('a branded 401 from authenticate passes through; an anonymous caller reaches the handler', async () => {
    const res = await fetch(`http://${endpointHost}/api/fallback/v1/o/d`, { headers: { 'x-no-auth': '1' } })
    t.assert(res.status === 401)
    t.compare(await decodeResponse(res), { error: 'unauthenticated' })
    const anon = await fetch(`http://${endpointHost}/api/whoami/v1/o/d`, { headers: { 'x-anon': '1' } })
    t.assert(anon.status === 200)
    t.compare(await decodeResponse(anon), { authInfo: null })
    t.compare(await decodeResponse(await fetch(`http://${endpointHost}/api/whoami/v1/o/d`)), { authInfo: { userid: 'endpointUser' } })
  })
}

/**
 * @param {t.TestCase} tc
 */
export const testCustomApiPrefix = async tc => {
  const { createWsClient } = await utils.createTestCase(tc)
  const docid = tc.testName + '-doc'
  const res = await fetch(`http://${prefixHost}/collaboration/echo/v1/testOrg/${docid}`)
  t.assert(res.status === 200)
  t.assert((await decodeResponse(res)).docid === docid)
  // the built-in endpoints follow the prefix
  const ydocRes = await fetch(`http://${prefixHost}/collaboration/ydoc/v1/testOrg/${docid}`)
  t.assert(ydocRes.status === 200)
  t.assert(buffer.decodeAny(new Uint8Array(await ydocRes.arrayBuffer())).doc instanceof Uint8Array)
  // ...and so does the websocket route
  await createWsClient({ wsUrl: `ws://${prefixHost}/collaboration/ws/v1/testOrg`, waitForSync: true })
  // the default prefix is not served on this hub
  const apiFailed = await fetch(`http://${prefixHost}/api/echo/v1/testOrg/${docid}`).then(res => !res.ok, () => true)
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
   * @type {Array<string>}
   */
  const optionsPatterns = []
  /**
   * @type {any}
   */
  const stubApp = { get: (/** @type {string} */ p) => { patterns.push(p); return stubApp }, post: () => stubApp, put: () => stubApp, patch: () => stubApp, del: () => stubApp, options: (/** @type {string} */ p) => { optionsPatterns.push(p); return stubApp } }
  /**
   * @param {Array<any>} api
   * @param {string} [apiPrefix]
   * @return {any}
   */
  const fakeYhub = (api, apiPrefix) => ({ conf: { server: { auth: null, api, apiPrefix } } })
  const handler = async () => ({})
  // valid baseline - membership, not position: the built-in endpoints register first
  registerApi(fakeYhub([{ name: 'a', get: { handler } }]), stubApp)
  t.assert(patterns.includes('/api/a/v1/:org/:docid'))
  t.assert(patterns.includes('/api/ydoc/v1/:org/:docid'))
  // without cors there is nothing to preflight - no OPTIONS route is registered
  t.assert(optionsPatterns.length === 0)
  // with cors, every endpoint gets its own preflight route, so Allow-Methods can be exact
  registerApi(/** @type {any} */ ({ conf: { server: { auth: null, api: [{ name: 'a', get: { handler } }], cors: { origin: '*' } } } }), stubApp)
  t.assert(optionsPatterns.includes('/api/a/v1/:org/:docid'))
  t.assert(optionsPatterns.includes('/api/ydoc/v1/:org/:docid'))
  // ... except for an endpoint that opts out via cors: null
  registerApi(/** @type {any} */ ({ conf: { server: { auth: null, api: [{ name: 'b', cors: null, get: { handler } }], cors: { origin: '*' } } } }), stubApp)
  t.assert(!optionsPatterns.includes('/api/b/v1/:org/:docid'))
  // same name under a different version is fine
  registerApi(fakeYhub([{ name: 'a', get: { handler } }, { name: 'a', version: 'v2', get: { handler } }]), stubApp)
  // same name at a different url depth is fine (collection + item)
  registerApi(fakeYhub([{ name: 'a', get: { handler } }, { name: 'a', path: '/:id', get: { handler } }]), stubApp)
  // duplicate (name, version) at the same url depth
  t.fails(() => registerApi(fakeYhub([{ name: 'a', get: { handler } }, { name: 'a', version: 'v1', get: { handler } }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', path: '/:x', get: { handler } }, { name: 'a', path: '/:y', get: { handler } }]), stubApp))
  // scope params count towards depth: doc-scope collides with org-scope + one path param
  t.fails(() => registerApi(fakeYhub([{ name: 'a', get: { handler } }, { name: 'a', scope: 'org', path: '/:id', get: { handler } }]), stubApp))
  // name must be a single segment
  t.fails(() => registerApi(fakeYhub([{ name: 'a/b', get: { handler } }]), stubApp))
  // name is required, version must be a string
  t.fails(() => registerApi(fakeYhub([{ get: { handler } }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', version: 2, get: { handler } }]), stubApp))
  // at least one method handler
  t.fails(() => registerApi(fakeYhub([{ name: 'a' }]), stubApp))
  // invalid scope
  t.fails(() => registerApi(fakeYhub([{ name: 'a', scope: 'world', get: { handler } }]), stubApp))
  // methods must be { handler } objects - the bare-function form of the pre-0.4 api throws
  t.fails(() => registerApi(fakeYhub([{ name: 'a', get: handler }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', get: {} }]), stubApp))
  // $query/$body specs go through s.$: a shape object (schemas, literals, arrays = unions) or a
  // prebuilt schema
  registerApi(fakeYhub([{ name: 'a', get: { $query: { q: s.$string, m: ['x', 'y'], l: 'z' }, handler } }]), stubApp)
  registerApi(fakeYhub([{ name: 'a', get: { $query: s.$object({ q: s.$string }), handler } }]), stubApp)
  // a shape value that is neither a schema nor a schema definition (s.$ throws)
  t.fails(() => registerApi(fakeYhub([{ name: 'a', get: { $query: { q: new Date() }, handler } }]), stubApp))
  // $body mirrors $query - non-object schemas are legal (a json body may be a bare value) - but
  // is not allowed on get
  registerApi(fakeYhub([{ name: 'a', post: { $body: { d: s.$uint8Array }, handler } }]), stubApp)
  registerApi(fakeYhub([{ name: 'a', post: { $body: s.$object({ d: s.$uint8Array }), handler } }]), stubApp)
  registerApi(fakeYhub([{ name: 'a', post: { $body: s.$array(s.$number), handler } }]), stubApp)
  t.fails(() => registerApi(fakeYhub([{ name: 'a', get: { $body: { d: s.$uint8Array }, handler } }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', post: { $body: { d: new Date() }, handler } }]), stubApp))
  // path params: named only, unique, org/docid/branch reserved
  t.fails(() => registerApi(fakeYhub([{ name: 'a', path: '/static', get: { handler } }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', path: '/:org', get: { handler } }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', path: '/:branch', get: { handler } }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', path: '/:x/:x', get: { handler } }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', path: ':x', get: { handler } }]), stubApp))
  // built-in endpoint names are refused in any version - they are excluded from the `endpoint`
  // permission facet, so a custom route under such a name would be gated by nothing
  t.fails(() => registerApi(fakeYhub([{ name: 'ydoc', get: { handler } }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'ws', get: { handler } }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'ydoc', version: 'v2', get: { handler } }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'ws', version: 'v2', get: { handler } }]), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'changeset', path: '/:id', get: { handler } }]), stubApp))
  // configurable prefix: everything - built-ins included - is served under the renamed segment
  patterns.length = 0
  registerApi(fakeYhub([{ name: 'a', get: { handler } }], 'collaboration'), stubApp)
  t.assert(patterns.includes('/collaboration/a/v1/:org/:docid'))
  t.assert(patterns.includes('/collaboration/activity/v1/:org/:docid'))
  // former reserved prefixes are now valid - there are no top-level routes left to collide with
  patterns.length = 0
  registerApi(fakeYhub([{ name: 'a', get: { handler } }], 'ydoc'), stubApp)
  t.assert(patterns.includes('/ydoc/a/v1/:org/:docid'))
  t.assert(patterns.includes('/ydoc/ydoc/v1/:org/:docid'))
  registerApi(fakeYhub([{ name: 'a', get: { handler } }], 'ws'), stubApp)
  // the prefix must be a single bare segment
  t.fails(() => registerApi(fakeYhub([{ name: 'a', get: { handler } }], 'my/api'), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', get: { handler } }], '/collaboration'), stubApp))
  t.fails(() => registerApi(fakeYhub([{ name: 'a', get: { handler } }], ''), stubApp))
}
