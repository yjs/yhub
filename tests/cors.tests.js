import * as t from 'lib0/testing'
import * as promise from 'lib0/promise'
import WebSocket from 'ws'
import * as types from '../src/types.js'
import * as utils from './utils.js'
import { apiError, createYHub } from '@y/hub'

const allowedOrigin = 'https://app.example.com'
const otherOrigin = 'https://admin.example.com'
const evilOrigin = 'https://evil.example'

const auth = types.createAuthPlugin({
  async readAuthInfo () { return { userid: 'corsUser' } },
  async getAccessType () { return 'rw' }
})

/**
 * @type {Array<import('../src/types.js').ApiEndpoint>}
 */
const corsApi = [
  { name: 'plain', get: { handler: async () => ({ ok: true }) } },
  { name: 'mut', post: { handler: async () => ({ ok: true }) } },
  // an endpoint opened up to every origin while the hub itself is locked down. The hub's
  // `credentials` must be disabled explicitly - the merged config is validated, and browsers
  // reject "*" together with credentials. The "*" allowHeaders entry needs `Authorization`
  // alongside - the Fetch wildcard never covers it
  { name: 'public', cors: { origin: '*', credentials: false, allowHeaders: ['*', 'Authorization'] }, get: { handler: async () => ({ ok: true }) }, post: { handler: async () => ({ ok: true }) } },
  // ... and one opted out of cors entirely - no cross-origin access, same-origin still works
  { name: 'private', cors: null, get: { handler: async () => ({ ok: true }) }, post: { handler: async () => ({ ok: true }) } },
  { name: 'fail', get: { handler: async () => { throw apiError(418, 'nope') } } },
  {
    name: 'resp',
    get: {
      handler: async () => new Response('hi', { headers: { 'access-control-allow-origin': 'https://handler.example', 'x-handler': 'handler-value' } })
    }
  },
  {
    // a Response that sets a single cors header without taking over Allow-Origin
    name: 'respexpose',
    get: {
      handler: async () => new Response('hi', { headers: { 'access-control-expose-headers': 'x-own' } })
    }
  },
  {
    // a Response with its own Vary must not suppress the configured `Vary: Origin`
    name: 'respvary',
    get: { handler: async () => new Response('hi', { headers: { vary: 'Accept' } }) }
  },
  { name: 'methods', get: { handler: async () => null }, delete: { handler: async () => null } }
]

/**
 * A partial override: inherits the hub's allowlist but drops the implicit same-origin trust -
 * only listed origins may post.
 *
 * @type {import('../src/types.js').ApiEndpoint}
 */
const strictEndpoint = { name: 'strict', cors: { trustSameOrigin: false }, post: { handler: async () => ({ ok: true }) } }

/**
 * An explicit `undefined` (an unset env var, a conditional spread) behaves like an absent
 * field - the endpoint inherits the hub's allowlist instead of losing it.
 *
 * @type {import('../src/types.js').ApiEndpoint}
 */
const inheritEndpoint = { name: 'inherit', cors: { origin: undefined }, get: { handler: async () => ({ ok: true }) } }

// a hub restricted to an explicit allowlist, with credentials enabled
const corsPort = utils.testHubPort(5)
const corsHost = `localhost:${corsPort}`
await utils.createTestHub({
  worker: null,
  server: {
    port: corsPort,
    auth,
    cors: {
      origin: [allowedOrigin, otherOrigin, 'https://*.preview.example.com'],
      credentials: true,
      allowHeaders: ['Content-Type', 'Authorization'],
      exposeHeaders: ['x-request-id'],
      maxAge: 7200
    },
    api: [...corsApi, strictEndpoint, inheritEndpoint]
  }
})

// a hub with no cors at all - the default
const barePort = utils.testHubPort(6)
const bareHost = `localhost:${barePort}`
await utils.createTestHub({
  worker: null,
  server: { port: barePort, auth, api: corsApi }
})

// a hub that enforces its allowlist even for same-origin requests
const strictPort = utils.testHubPort(7)
const strictHost = `localhost:${strictPort}`
await utils.createTestHub({
  worker: null,
  server: { port: strictPort, auth, cors: { origin: [allowedOrigin], trustSameOrigin: false }, api: corsApi }
})

/**
 * @param {Response} res
 */
const corsHeaders = res => ({
  origin: res.headers.get('access-control-allow-origin'),
  credentials: res.headers.get('access-control-allow-credentials'),
  methods: res.headers.get('access-control-allow-methods'),
  allowHeaders: res.headers.get('access-control-allow-headers'),
  exposeHeaders: res.headers.get('access-control-expose-headers'),
  maxAge: res.headers.get('access-control-max-age'),
  vary: res.headers.get('vary')
})

/**
 * @param {t.TestCase} tc
 */
export const testAllowlist = async tc => {
  const { org } = await utils.createTestCase(tc)
  const url = `http://${corsHost}/api/plain/v1/${org}/${tc.testName}-doc`
  await t.groupAsync('a listed origin is echoed back, with Vary and credentials', async () => {
    const res = await fetch(url, { headers: { Origin: allowedOrigin } })
    const h = corsHeaders(res)
    t.assert(h.origin === allowedOrigin)
    t.assert(h.credentials === 'true')
    t.assert(h.vary === 'Origin')
    // the second listed origin resolves independently
    const res2 = await fetch(url, { headers: { Origin: otherOrigin } })
    t.assert(corsHeaders(res2).origin === otherOrigin)
  })
  await t.groupAsync('an unlisted origin is denied, without any Access-Control header', async () => {
    const res = await fetch(url, { headers: { Origin: evilOrigin } })
    t.assert(res.status === 403)
    const h = corsHeaders(res)
    t.assert(h.origin === null)
    t.assert(h.credentials === null)
    // Vary still has to be sent - the response varies by origin even when it is refused
    t.assert(h.vary === 'Origin')
  })
  await t.groupAsync('a request without Origin is served normally', async () => {
    const res = await fetch(url)
    t.assert(res.status === 200)
    t.assert(corsHeaders(res).origin === null)
  })
}

/**
 * @param {t.TestCase} tc
 */
export const testHeaderSplit = async tc => {
  const { org } = await utils.createTestCase(tc)
  const url = `http://${corsHost}/api/methods/v1/${org}/${tc.testName}-doc`
  await t.groupAsync('a normal response carries only the headers it needs', async () => {
    const h = corsHeaders(await fetch(url, { headers: { Origin: allowedOrigin } }))
    t.assert(h.origin === allowedOrigin)
    t.assert(h.exposeHeaders === 'x-request-id')
    // preflight-only headers are ignored by browsers here
    t.assert(h.methods === null)
    t.assert(h.allowHeaders === null)
    t.assert(h.maxAge === null)
  })
  await t.groupAsync('a preflight carries only the headers it needs', async () => {
    const res = await fetch(url, { method: 'OPTIONS', headers: { Origin: allowedOrigin, 'Access-Control-Request-Method': 'DELETE' } })
    t.assert(res.status === 204)
    const h = corsHeaders(res)
    t.assert(h.origin === allowedOrigin)
    t.assert(h.allowHeaders === 'Content-Type, Authorization')
    t.assert(h.maxAge === '7200')
    // Expose-Headers means nothing on a preflight
    t.assert(h.exposeHeaders === null)
  })
  await t.groupAsync('Allow-Methods and Allow list exactly the endpoint\'s methods', async () => {
    const res = await fetch(url, { method: 'OPTIONS', headers: { Origin: allowedOrigin, 'Access-Control-Request-Method': 'DELETE' } })
    const methods = (corsHeaders(res).methods ?? '').split(', ').sort()
    t.compare(methods, ['DELETE', 'GET', 'OPTIONS'])
    // rfc 9110: the options response itself says what the resource supports
    t.compare((res.headers.get('allow') ?? '').split(', ').sort(), ['DELETE', 'GET', 'OPTIONS'])
  })
  await t.groupAsync('an unregistered path has no preflight route - uws answers its default 404', async () => {
    const res = await fetch(`http://${corsHost}/api/nope/v1/${org}/x`, { method: 'OPTIONS', headers: { Origin: allowedOrigin } })
    t.assert(res.status === 404)
    t.assert(corsHeaders(res).origin === null)
  })
}

/**
 * @param {t.TestCase} tc
 */
export const testErrorResponses = async tc => {
  const { org } = await utils.createTestCase(tc)
  const res = await fetch(`http://${corsHost}/api/fail/v1/${org}/${tc.testName}-doc`, { headers: { Origin: allowedOrigin, Accept: 'application/json' } })
  t.assert(res.status === 418)
  t.assert(corsHeaders(res).origin === allowedOrigin)
}

/**
 * @param {t.TestCase} tc
 */
export const testEndpointOverrides = async tc => {
  const { org } = await utils.createTestCase(tc)
  const docid = tc.testName + '-doc'
  await t.groupAsync('cors: { origin: "*" } opens a single endpoint', async () => {
    const res = await fetch(`http://${corsHost}/api/public/v1/${org}/${docid}`, { headers: { Origin: evilOrigin } })
    t.assert(corsHeaders(res).origin === '*')
    // '*' does not depend on the request, so no Vary
    t.assert(res.headers.get('vary') === null)
    const pre = await fetch(`http://${corsHost}/api/public/v1/${org}/${docid}`, { method: 'OPTIONS', headers: { Origin: evilOrigin } })
    t.assert(corsHeaders(pre).origin === '*')
    // the override replaces the hub's origin, credentials, and allowHeaders but inherits the
    // rest - asserted on the hub's non-default maxAge and exposeHeaders, which only
    // inheritance can produce
    t.assert(corsHeaders(pre).allowHeaders === '*, Authorization')
    t.assert(corsHeaders(pre).maxAge === '7200')
    t.assert(corsHeaders(res).exposeHeaders === 'x-request-id')
    t.assert(corsHeaders(res).credentials === null)
  })
  await t.groupAsync('an explicit `origin: undefined` in an override inherits the hub allowlist', async () => {
    const res = await fetch(`http://${corsHost}/api/inherit/v1/${org}/${docid}`, { headers: { Origin: allowedOrigin } })
    t.assert(corsHeaders(res).origin === allowedOrigin)
    t.assert((await fetch(`http://${corsHost}/api/inherit/v1/${org}/${docid}`, { headers: { Origin: evilOrigin } })).status === 403)
  })
  await t.groupAsync('cors: null disables cors on a single endpoint', async () => {
    // no cross-origin access at all - the origin gate denies reads too - while same-origin
    // pages keep working, without any cors header (they don't need one)
    const res = await fetch(`http://${corsHost}/api/private/v1/${org}/${docid}`, { headers: { Origin: allowedOrigin } })
    t.assert(res.status === 403)
    const same = await fetch(`http://${corsHost}/api/private/v1/${org}/${docid}`, { headers: { Origin: `http://${corsHost}` } })
    t.assert(same.status === 200)
    t.assert(corsHeaders(same).origin === null)
    // the origin gate still makes responses differ by Origin - shared caches must know
    t.assert(corsHeaders(res).vary === 'Origin')
    t.assert(corsHeaders(same).vary === 'Origin')
    // without cors there is nothing to preflight - no OPTIONS route is registered at all
    const pre = await fetch(`http://${corsHost}/api/private/v1/${org}/${docid}`, { method: 'OPTIONS', headers: { Origin: allowedOrigin } })
    t.assert(pre.status === 404)
    t.assert(corsHeaders(pre).origin === null)
  })
}

/**
 * @param {t.TestCase} tc
 */
export const testResponseHandlerWins = async tc => {
  const { org } = await utils.createTestCase(tc)
  const docid = tc.testName + '-doc'
  const res = await fetch(`http://${corsHost}/api/resp/v1/${org}/${docid}`, { headers: { Origin: allowedOrigin } })
  // a handler's own Response controls its headers - each must appear exactly once
  t.assert(res.headers.get('access-control-allow-origin') === 'https://handler.example')
  t.assert(res.headers.get('x-handler') === 'handler-value')
  // ... except `Vary: Origin`, which survives even a Response that takes over Allow-Origin -
  // the route's responses vary by origin toward shared caches no matter who writes the header
  t.assert((res.headers.get('vary') ?? '').includes('Origin'))
  // a Response that sets a single cors header keeps the configured Allow-Origin, but its own
  // header is written once - by the handler, not the config (which says 'x-request-id')
  const expose = await fetch(`http://${corsHost}/api/respexpose/v1/${org}/${docid}`, { headers: { Origin: allowedOrigin } })
  t.assert(expose.headers.get('access-control-allow-origin') === allowedOrigin)
  t.assert(expose.headers.get('access-control-expose-headers') === 'x-own')
  // a Response's own Vary combines with the configured `Vary: Origin` - the origin-variance
  // signal toward shared caches must never be lost
  const vary = await fetch(`http://${corsHost}/api/respvary/v1/${org}/${docid}`, { headers: { Origin: allowedOrigin } })
  const varyHeader = vary.headers.get('vary') ?? ''
  t.assert(varyHeader.includes('Origin') && varyHeader.includes('Accept'))
  t.assert(vary.headers.get('access-control-allow-origin') === allowedOrigin)
}

/**
 * @param {t.TestCase} tc
 */
export const testWildcardOrigin = async tc => {
  const { org } = await utils.createTestCase(tc)
  const url = `http://${corsHost}/api/plain/v1/${org}/${tc.testName}-doc`
  /**
   * @param {string} origin
   */
  const echoed = async origin => corsHeaders(await fetch(url, { headers: { Origin: origin } })).origin
  await t.groupAsync('the star matches one or several subdomain labels', async () => {
    t.assert(await echoed('https://x.preview.example.com') === 'https://x.preview.example.com')
    t.assert(await echoed('https://a.b.preview.example.com') === 'https://a.b.preview.example.com')
  })
  await t.groupAsync('the star never matches the apex, a lookalike, or another port', async () => {
    t.assert(await echoed('https://preview.example.com') === null)
    t.assert(await echoed('https://evil-preview.example.com') === null)
    t.assert(await echoed('https://x.preview.example.com:8443') === null)
  })
}

/**
 * @param {t.TestCase} tc
 */
export const testOriginGate = async tc => {
  const { org } = await utils.createTestCase(tc)
  const docid = tc.testName + '-doc'
  const mut = `http://${corsHost}/api/mut/v1/${org}/${docid}`
  // browsers send "simple" cross-site POSTs without a preflight, so the server checks the
  // allowlist itself before anything runs
  await t.groupAsync('a POST from an unlisted origin is rejected', async () => {
    const res = await fetch(mut, { method: 'POST', headers: { Origin: evilOrigin } })
    t.assert(res.status === 403)
    // the gate only denies requests carrying an Origin - a browser is on the other end, so the
    // body is json regardless of Accept, with a code that tells this 403 from an auth 403
    t.assert((res.headers.get('content-type') ?? '').includes('application/json'))
    t.compare(await res.json(), { error: 'origin not allowed', code: 'origin-not-allowed' })
  })
  await t.groupAsync('a POST from a listed or wildcard-matched origin passes', async () => {
    t.assert((await fetch(mut, { method: 'POST', headers: { Origin: allowedOrigin } })).status === 200)
    t.assert((await fetch(mut, { method: 'POST', headers: { Origin: 'https://x.preview.example.com' } })).status === 200)
  })
  await t.groupAsync('a POST without Origin is never restricted', async () => {
    t.assert((await fetch(mut, { method: 'POST' })).status === 200)
  })
  await t.groupAsync('GET is gated like every other method - cors only hides responses', async () => {
    t.assert((await fetch(`http://${corsHost}/api/plain/v1/${org}/${docid}`, { headers: { Origin: evilOrigin } })).status === 403)
    t.assert((await fetch(`http://${corsHost}/api/plain/v1/${org}/${docid}`, { headers: { Origin: allowedOrigin } })).status === 200)
  })
  await t.groupAsync('an endpoint opened to "*" accepts a POST from anywhere', async () => {
    t.assert((await fetch(`http://${corsHost}/api/public/v1/${org}/${docid}`, { method: 'POST', headers: { Origin: evilOrigin } })).status === 200)
  })
  await t.groupAsync('a hub without cors denies cross-origin, but same-origin passes', async () => {
    t.assert((await fetch(`http://${bareHost}/api/mut/v1/${org}/${docid}`, { method: 'POST', headers: { Origin: evilOrigin } })).status === 403)
    // same-origin: the Origin's host equals the request's Host - the scheme is not compared,
    // so a tls-terminating proxy in front doesn't break the gate
    t.assert((await fetch(`http://${bareHost}/api/mut/v1/${org}/${docid}`, { method: 'POST', headers: { Origin: `http://${bareHost}` } })).status === 200)
    t.assert((await fetch(`http://${bareHost}/api/mut/v1/${org}/${docid}`, { method: 'POST', headers: { Origin: `https://${bareHost}` } })).status === 200)
  })
  await t.groupAsync('same-origin passes on an allowlist hub too, unless trustSameOrigin is false', async () => {
    t.assert((await fetch(mut, { method: 'POST', headers: { Origin: `http://${corsHost}` } })).status === 200)
    // ... per endpoint: the partial override inherits the allowlist, drops the trust
    const strict = `http://${corsHost}/api/strict/v1/${org}/${docid}`
    t.assert((await fetch(strict, { method: 'POST', headers: { Origin: `http://${corsHost}` } })).status === 403)
    t.assert((await fetch(strict, { method: 'POST', headers: { Origin: allowedOrigin } })).status === 200)
    // ... per hub
    t.assert((await fetch(`http://${strictHost}/api/mut/v1/${org}/${docid}`, { method: 'POST', headers: { Origin: `http://${strictHost}` } })).status === 403)
    t.assert((await fetch(`http://${strictHost}/api/mut/v1/${org}/${docid}`, { method: 'POST', headers: { Origin: allowedOrigin } })).status === 200)
  })
  await t.groupAsync('cors: null means no cross-origin access - same-origin still posts', async () => {
    const priv = `http://${corsHost}/api/private/v1/${org}/${docid}`
    t.assert((await fetch(priv, { method: 'POST', headers: { Origin: allowedOrigin } })).status === 403)
    t.assert((await fetch(priv, { method: 'POST', headers: { Origin: `http://${corsHost}` } })).status === 200)
  })
  await t.groupAsync('cors: null under a strict hub falls back to the implicit same-origin trust', async () => {
    // null means "as if cors were unset" - which trusts same-origin - not "most restrictive":
    // the opted-out endpoint is more permissive for same-origin pages than the hub around it
    const priv = `http://${strictHost}/api/private/v1/${org}/${docid}`
    t.assert((await fetch(priv, { method: 'POST', headers: { Origin: `http://${strictHost}` } })).status === 200)
    t.assert((await fetch(priv, { method: 'POST', headers: { Origin: allowedOrigin } })).status === 403)
  })
  await t.groupAsync('Sec-Fetch-Site guards the implicit same-origin trust', async () => {
    const bare = `http://${bareHost}/api/mut/v1/${org}/${docid}`
    // an http page targeting the https api: the Origin's host equals Host, but the browser
    // reports the schemeful relation - the scheme-blind comparison alone cannot see this
    t.assert((await fetch(bare, { method: 'POST', headers: { Origin: `http://${bareHost}`, 'Sec-Fetch-Site': 'cross-site' } })).status === 403)
    t.assert((await fetch(bare, { method: 'POST', headers: { Origin: `http://${bareHost}`, 'Sec-Fetch-Site': 'same-origin' } })).status === 200)
    t.assert((await fetch(bare, { method: 'POST', headers: { Origin: `http://${bareHost}`, 'Sec-Fetch-Site': 'none' } })).status === 200)
    // a listed origin is legitimately cross-site - the allowlist wins over the fetch metadata
    t.assert((await fetch(mut, { method: 'POST', headers: { Origin: allowedOrigin, 'Sec-Fetch-Site': 'cross-site' } })).status === 200)
  })
}

export const testDefaults = async () => {
  // the main test hub configures only `origin` - allowHeaders and maxAge come from the defaults
  const res = await fetch(`http://${utils.yhubHost}/api/ydoc/v1/org/doc`, { method: 'OPTIONS', headers: { Origin: allowedOrigin } })
  t.assert(res.status === 204)
  const h = corsHeaders(res)
  t.assert(h.allowHeaders === 'Content-Type, Authorization')
  t.assert(h.maxAge === '3600')
}

/**
 * @param {t.TestCase} tc
 */
export const testNoCorsByDefault = async tc => {
  const { org } = await utils.createTestCase(tc)
  const docid = tc.testName + '-doc'
  const responses = [
    // a cross-origin request is denied by the origin gate - reads included
    { label: 'denial', status: 403, res: await fetch(`http://${bareHost}/api/plain/v1/${org}/${docid}`, { headers: { Origin: allowedOrigin } }) },
    // same-origin requests are served, without any Access-Control header - they don't need one
    { label: 'response', status: 200, res: await fetch(`http://${bareHost}/api/plain/v1/${org}/${docid}`, { headers: { Origin: `http://${bareHost}` } }) },
    { label: 'error', status: 418, res: await fetch(`http://${bareHost}/api/fail/v1/${org}/${docid}`, { headers: { Origin: `http://${bareHost}` } }) }
  ]
  for (const { label, status, res } of responses) {
    t.info(`no cors on the ${label}`)
    t.assert(res.status === status)
    const h = corsHeaders(res)
    t.assert(h.origin === null && h.methods === null && h.allowHeaders === null)
    // ... except `Vary: Origin`: the origin gate answers the same url 200 same-origin and 403
    // cross-origin, and shared caches must know
    t.assert(h.vary === 'Origin')
  }
  // without cors there is nothing to preflight - no OPTIONS route exists, uws answers 404
  const pre = await fetch(`http://${bareHost}/api/plain/v1/${org}/${docid}`, { method: 'OPTIONS', headers: { Origin: allowedOrigin } })
  t.assert(pre.status === 404)
  t.assert(corsHeaders(pre).origin === null)
}

export const testInvalidConfig = async () => {
  /**
   * @param {any} server
   * @param {string} label
   */
  const expectThrow = async (server, label) => {
    t.info(label)
    await t.failsAsync(async () => {
      await createYHub({ ...utils.yhub.conf, worker: null, server: { port: utils.testHubPort(8), auth, ...server } })
    })
  }
  await expectThrow({ cors: { origin: '*', credentials: true } }, 'browsers reject "*" with credentials')
  await expectThrow({ cors: { origin: 'https://app.example.com/' } }, 'a trailing slash never matches an Origin header')
  await expectThrow({ cors: { origin: 'https://app.example.com ' } }, 'surrounding whitespace never matches an Origin header')
  await expectThrow({ cors: { origin: 'app.example.com' } }, 'an origin needs a scheme')
  await expectThrow({ cors: { origin: 'null' } }, '"null" would allow every sandboxed page')
  await expectThrow({ cors: { origin: [] } }, 'an empty allowlist is a mistake, not a policy')
  await expectThrow({ cors: { origin: [allowedOrigin, ''] } }, 'an empty entry is a doubled or trailing comma')
  await expectThrow({ cors: { origin: ['*'] } }, '"*" in an allowlist is not how every origin is allowed')
  await expectThrow({ cors: { origin: 'https://*example.com' } }, 'a wildcard star must be followed by a dot')
  await expectThrow({ cors: { origin: 'https://app-*.example.com' } }, 'the star must start the host')
  await expectThrow({ cors: { origin: 'https://*.exam*.com' } }, 'only a single star is allowed')
  await expectThrow({ cors: { origin: 'https://*.com' } }, 'a wildcard needs at least two labels after the star')
  await expectThrow({ cors: { origin: 'https://app.example.com:443' } }, 'browsers omit the default port, so it never matches')
  await expectThrow({ cors: { origin: [allowedOrigin], credentials: true, allowHeaders: ['*'] } }, 'a "*" header entry does not work with credentials')
  await expectThrow({ cors: { origin: [allowedOrigin], allowHeaders: ['*'] } }, 'a bare "*" never covers Authorization - it must be listed alongside')
  await expectThrow({ cors: { origin: [allowedOrigin], allowHeaders: [123] } }, 'header entries must be strings')
  await expectThrow({ cors: { origin: [allowedOrigin], allowHeaders: 'Content-Type' } }, 'allowHeaders must be an array, not a comma-string')
  await expectThrow({ cors: { origin: [allowedOrigin], maxAge: 1.5 } }, 'maxAge must be an integer')
  await expectThrow({ cors: { origin: [allowedOrigin], maxAge: '3600' } }, 'a stringly maxAge throws')
  await expectThrow({ cors: { origin: [allowedOrigin], maxAge: -1 } }, 'negative delta-seconds are invalid on the wire - browsers fall back to 5s, not "no cache"')
  await expectThrow({ cors: { origin: true } }, 'a boolean origin (express\'s reflect-the-request) is not supported')
  await expectThrow({ cors: { origin: /example\.com$/ } }, 'a regex origin is not supported - the allowlist is fixed at startup')
  await expectThrow({ cors: { origin: `${allowedOrigin},${otherOrigin}` } }, 'a comma-joined string is not an allowlist - use an array')
  // the merged per-endpoint config is validated too - "*" + credentials throws no matter which
  // side each half comes from
  await expectThrow({
    cors: { origin: '*' },
    api: [{ name: 'x', cors: { credentials: true }, get: { handler: async () => null } }]
  }, 'an endpoint asking for credentials while inheriting "*"')
  await expectThrow({
    cors: { origin: [allowedOrigin], credentials: true },
    api: [{ name: 'x', cors: { origin: '*' }, get: { handler: async () => null } }]
  }, 'an endpoint opening itself to "*" while inheriting credentials (must set credentials: false)')
  // endpoint overrides bypass the config schema, so resolveCors validates the merged result
  // field by field - a typo or a stringly value must not be silently ignored
  await expectThrow({
    cors: { origin: [allowedOrigin] },
    api: [{ name: 'x', cors: { allowedHeaders: ['X-Custom'] }, get: { handler: async () => null } }]
  }, 'a typoed override field (allowedHeaders) throws')
  await expectThrow({
    cors: { origin: [allowedOrigin] },
    api: [{ name: 'x', cors: { credentials: 'yes' }, get: { handler: async () => null } }]
  }, 'a stringly credentials value throws')
  await expectThrow({
    cors: { origin: [allowedOrigin] },
    api: [{ name: 'x', cors: { trustSameOrigin: 'yes' }, get: { handler: async () => null } }]
  }, 'a stringly trustSameOrigin value throws')
  await expectThrow({
    cors: { origin: [allowedOrigin] },
    // `false` is how other frameworks disable per-route cors - accepting it would silently
    // inherit the full hub config instead of closing the endpoint off
    api: [{ name: 'x', cors: false, get: { handler: async () => null } }]
  }, 'cors: false is refused - only null disables')
  await expectThrow({
    cors: { origin: [allowedOrigin] },
    // an array would silently inherit the full hub config the same way a primitive would
    api: [{ name: 'x', cors: [], get: { handler: async () => null } }]
  }, 'cors: [] is refused - an array is not a config object')
  await expectThrow({
    api: [{ name: 'x', cors: { credentials: false }, get: { handler: async () => null } }]
  }, 'an endpoint override cannot inherit `origin` from a hub without cors')
}

/**
 * @param {string} host
 * @param {string|undefined} origin
 * @param {{ [name: string]: string }} [headers]
 */
const wsStatus = (host, origin, headers = {}) => promise.create((resolve) => {
  const ws = new WebSocket(`ws://${host}/api/ws/v1/org/doc`, { ...(origin == null ? {} : { origin }), headers })
  ws.on('open', () => { ws.close(); resolve('open') })
  ws.on('unexpected-response', (_req, res) => { ws.terminate(); resolve(`${res.statusCode}`) })
  ws.on('error', () => resolve('error'))
})

export const testWebsocketOrigin = async () => {
  // browsers don't enforce cors on websockets, so yhub checks the allowlist itself
  await t.groupAsync('an unlisted origin cannot open a websocket', async () => {
    t.assert(await wsStatus(corsHost, evilOrigin) === '403')
  })
  await t.groupAsync('a listed or wildcard-matched origin can', async () => {
    t.assert(await wsStatus(corsHost, allowedOrigin) === 'open')
    t.assert(await wsStatus(corsHost, 'https://x.preview.example.com') === 'open')
  })
  await t.groupAsync('a client that sends no Origin is never restricted', async () => {
    t.assert(await wsStatus(corsHost, undefined) === 'open')
  })
  await t.groupAsync('a hub without cors denies cross-origin, but same-origin connects', async () => {
    t.assert(await wsStatus(bareHost, evilOrigin) === '403')
    t.assert(await wsStatus(bareHost, `http://${bareHost}`) === 'open')
  })
  await t.groupAsync('trustSameOrigin: false enforces the allowlist even same-origin', async () => {
    t.assert(await wsStatus(corsHost, `http://${corsHost}`) === 'open')
    t.assert(await wsStatus(strictHost, `http://${strictHost}`) === '403')
    t.assert(await wsStatus(strictHost, allowedOrigin) === 'open')
  })
  await t.groupAsync('Sec-Fetch-Site guards the implicit same-origin trust on upgrades too', async () => {
    t.assert(await wsStatus(bareHost, `http://${bareHost}`, { 'sec-fetch-site': 'cross-site' }) === '403')
    t.assert(await wsStatus(bareHost, `http://${bareHost}`, { 'sec-fetch-site': 'same-origin' }) === 'open')
  })
}
