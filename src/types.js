import * as Y from '@y/y'
import * as s from 'lib0/schema'

/**
 * # Asset
 *
 * Types of content we deal with (v1 encoded ydocs, v2 encoded ydocs, v1 encoded contentmaps, ..)
 *
 * # AssetIds
 *
 * Describe how to retrieve any asset.
 */

export const $ydocAssetId = s.$({
  type: s.$literal('id:ydoc:v1'),
  org: s.$string,
  docid: s.$string,
  branch: s.$string,
  t: s.$string,
  gc: s.$boolean
})

export const $contentMapAssetId = s.$({
  type: s.$literal('id:contentmap:v1'),
  org: s.$string,
  docid: s.$string,
  branch: s.$string,
  t: s.$string
})

export const $contentidsAssetId = s.$({
  type: s.$literal('id:contentids:v1'),
  org: s.$string,
  docid: s.$string,
  branch: s.$string,
  t: s.$string
})

export const $contentMapAsset = s.$({
  type: s.$literal('asset:contentmap:v1'),
  contentmap: s.$uint8Array
})

export const $contentidsAsset = s.$({
  type: s.$literal('asset:contentids:v1'),
  contentids: s.$uint8Array
})

export const $ydocAsset = s.$({
  type: s.$literal('asset:ydoc:v1'),
  update: s.$uint8Array
})

export const $retrievableAsset = s.$({
  type: s.$literal('asset:retrievable:v1'),
  plugin: s.$string
})

export const $assetId = s.$union($ydocAssetId, $contentMapAssetId, $contentidsAssetId)

export const $asset = s.$union($ydocAsset, $contentMapAsset, $contentidsAsset, $retrievableAsset)

/**
 * @typedef {s.Unwrap<typeof $retrievableAsset>} RetrievableAsset
 */

/**
 * @typedef {s.Unwrap<typeof $asset>} Asset
 */

/**
 * @typedef {s.Unwrap<typeof $assetId>} AssetId
 */

/**
 * Helpful utility to implement a generic storage module.
 *
 * @param {AssetId} assetId
 */
export const assetIdToString = assetId => {
  switch (assetId.type) {
    case 'id:ydoc:v1':
      return `${assetId.type}/${encodeURIComponent(assetId.org)}/${encodeURIComponent(assetId.docid)}/${encodeURIComponent(assetId.branch)}/${assetId.gc ? 1 : 0}/${encodeURIComponent(assetId.t)}`
    case 'id:contentmap:v1':
    case 'id:contentids:v1':
      return `${assetId.type}/${encodeURIComponent(assetId.org)}/${encodeURIComponent(assetId.docid)}/${encodeURIComponent(assetId.branch)}/${encodeURIComponent(assetId.t)}`
  }
  s.$never.expect(assetId)
}

/**
 * @param {string} assetIdString
 * @returns {AssetId}
 */
export const assetIdFromString = assetIdString => {
  const parts = assetIdString.split('/')
  const type = parts[0]
  switch (type) {
    case 'id:ydoc:v1':
      return {
        type,
        org: decodeURIComponent(parts[1]),
        docid: decodeURIComponent(parts[2]),
        branch: decodeURIComponent(parts[3]),
        gc: parts[4] === '1',
        t: decodeURIComponent(parts[5])
      }
    case 'id:contentmap:v1':
    case 'id:contentids:v1':
      return {
        type,
        org: decodeURIComponent(parts[1]),
        docid: decodeURIComponent(parts[2]),
        branch: decodeURIComponent(parts[3]),
        t: decodeURIComponent(parts[4])
      }
  }
  throw new Error(`Unknown asset type: ${type}`)
}

export const $updateMessage = s.$({
  type: s.$literal('ydoc:update:v1'),
  update: s.$uint8Array,
  contentmap: s.$uint8Array
})

export const $awarenessMessage = s.$({
  type: s.$literal('awareness:v1'),
  update: s.$uint8Array
})

/**
 * Directive to permanently prune churned history. `prune` is an `IdSet` (serialized with
 * `Y.encodeIdSet`) of content that was inserted and later deleted; it is garbage-collected
 * from the nongc doc and removed from the contentmap when documents are merged.
 */
export const $pruneMessage = s.$({
  type: s.$literal('prune:v1'),
  prune: s.$uint8Array
})

/**
 * Directive to re-check permissions of the websocket connections of a document (see
 * `YHub.recheckAuth`). `users` is an array of authInfo matchers — `null` matches every
 * connection. `forceDisconnect` disconnects matching connections without re-checking access.
 */
export const $authCheckMessage = s.$({
  type: s.$literal('auth:check:v1'),
  users: s.$array(s.$union(s.$string, s.$objectAny)).nullable,
  forceDisconnect: s.$boolean
})

/**
 * Directive that a document was deleted (see `YHub.deleteDoc`). Payload-free: connections are
 * kicked identically for hard and soft deletions, and anything that needs the distinction reads
 * the deletion record from postgres. That also makes it replay-idempotent, so - unlike
 * `auth:check:v1` - it survives `unquarantine` re-injection without a special case.
 */
export const $tombstoneMessage = s.$({
  type: s.$literal('ydoc:tombstone:v1')
})

/**
 * A Message contains information w want to distribute to clients. They are usually put on the
 * distribution stream.
 */
export const $message = s.$union($updateMessage, $awarenessMessage, $pruneMessage, $authCheckMessage, $tombstoneMessage)

/**
 * @typedef {s.Unwrap<typeof $message>} Message
 */

export const $docRef = s.$object({ org: s.$string, docid: s.$string, branch: s.$string })

/**
 * @typedef {s.Unwrap<typeof $docRef>} DocRef
 */

/**
 * The record of a deleted document (table `yhub_ydoc_tombstones_v1`), keyed by docRef. `deletedAt` and
 * `purgedAt` are unix milliseconds read from redis `TIME`, so they are free of server clock skew
 * and share the clock domain of `yhub_ydoc_v1.created`. `purgedAt` is null until the content has
 * actually been erased - immediately for a hard deletion, whenever the retention task runs for a
 * soft one.
 *
 * @typedef {{ org: string, docid: string, branch: string, deletedAt: number, hard: boolean, purgedAt: number|null, by: string|null }} Tombstone
 */

/**
 * Thrown at a callsite that read a deleted document (see `YHub.deleteDoc`). `getDoc` itself never
 * throws it - it reports the deletion as `tombstone` and each caller decides. Most refuse; the
 * compact worker is the one that carries on, because it still has to trim the stream.
 */
export class DocDeletedError extends Error {
  /**
   * @param {DocRef} docRef
   * @param {Tombstone} tombstone
   */
  constructor (docRef, tombstone) {
    super(`document was deleted: ${docRef.org}/${docRef.docid}/${docRef.branch}`)
    this.docRef = docRef
    this.tombstone = tombstone
  }
}

export const $compactTask = s.$({
  type: s.$literal('compact'),
  docRef: {
    org: s.$string,
    docid: s.$string,
    branch: s.$string
  }
})

export const $task = $compactTask

/**
 * @typedef {s.Unwrap<typeof $task>} Task
 */

/**
 * @template {{[K:string]:any}} Conf
 * @template {string} Key
 * @template Result
 * @typedef {(Conf[Key] extends true ? Result : (Conf[Key] extends boolean ? (Result|null) : null))} IfHasConf
 */

// @todo rename 'gc' and 'nongc' to 'gcDoc' and `nongcDoc`
/**
 * @template {{ gc?: boolean, nongc?: boolean, contentmap?: boolean, references?: boolean, contentids?: boolean, awareness?: boolean }} [Include=any]
 * @typedef {import('lib0/ts').Prettify<{
 *   lastClock: string,
 *   lastPersistedClock: string,
 *   tombstone: Tombstone|null,
 *   gcDoc: IfHasConf<Include, 'gc', Uint8Array<ArrayBuffer>>,
 *   nongcDoc: IfHasConf<Include, 'nongc', Uint8Array<ArrayBuffer>>,
 *   contentmap: IfHasConf<Include, 'contentmap', Uint8Array<ArrayBuffer>>,
 *   references: IfHasConf<Include, 'references', Array<{ assetId: AssetId, asset: Asset|null }>>,
 *   contentids: IfHasConf<Include, 'contentids', Uint8Array<ArrayBuffer>>,
 *   awareness: IfHasConf<Include, 'awareness', Uint8Array<ArrayBuffer>>,
 *   authChecks: Array<s.Unwrap<typeof $authCheckMessage>>
 * }, 1>} DocTable
 */

/**
 * `delete` removes a single asset that is no longer referenced - a superseded version during
 * compaction, or every version of a document during `YHub.purgeDoc`. Both reach it through
 * `Persistence.deleteReferences`, which drops the referencing row first, so an asset deletion
 * that is delayed or lost leaks an orphaned object rather than leaving a row pointing at
 * nothing.
 *
 * @typedef {object} PersistencePlugin
 * @property {null|((api: import('./index.js').YHub)=>Promise<any>?)} [PersistPlugin.init]
 * @property {null|((assetId: AssetId, asset: Asset)=>Promise<RetrievableAsset?>)} [PersistPlugin.store]
 * @property {null|((assetId: AssetId, assetInfo: Asset)=>Promise<Asset?>)} [PersistPlugin.retrieve]
 * @property {null|((assetId: AssetId, assetInfo: Asset)=>Promise<boolean>)} [PersistPlugin.delete]
 */

/**
 * @type {s.Schema<PersistencePlugin>}
 */
export const $persistencePlugin = s.$object({
  init: /** @type {s.Schema<()=>any>} */ (s.$function),
  store: /** @type {s.Schema<()=>any>} */ (s.$function).nullable.optional,
  retrieve: /** @type {s.Schema<()=>any>} */ (s.$function).nullable.optional
})

export const $authPlugin = /** @type {s.Schema<AuthPlugin<any>>} */ (s.$object({
  authenticate: /** @type {any} */ (s.$function),
  authorize: /** @type {any} */ (s.$function)
}))

/**
 * @typedef {{ userid: string }} UserAuthInfo
 */

/**
 * The auth plugin (`server.auth`): `authenticate` establishes who is asking, `authorize` answers
 * what they may do with one resource - a typed permission object per scope (see
 * `@y/hub/permissions` and proposals/permissions.md).
 *
 * @template {UserAuthInfo} AuthInfo
 * @typedef {object} AuthPlugin
 * @property {(req: import('uws').HttpRequest) => Promise<AuthInfo|null>} AuthPlugin.authenticate - establish who is asking: return the caller's identity (`{ userid, ... }`) or null for an anonymous caller - `authorize` is then asked with `user: null` and may still grant (public documents). Throw a branded `apiError(401, ...)` (from `@y/hub`) to reject a presented credential, `apiError(503, ...)` to signal a temporary auth-backend outage - rest requests and the websocket upgrade respond with that status. Any other throw is an infrastructure failure and answers 503.
 * @property {<Scope extends import('./permissions.js').PermissionScope>(scope: Scope, resourceId: import('./permissions.js').PermissionResourceId<Scope>, user: AuthInfo|null) => Promise<import('./permissions.js').ToPermissionType<Scope> | null>} AuthPlugin.authorize - answer the input-form permissions of `user` (null: anonymous) on the addressed resource. `scope` names the tier ('document' → resourceId {org, docid, branch}, 'branch' → {org, branch}, 'org' → {org}, 'global' → {}) and the return type is forced to match it (`ToPermissionType<Scope>` from `@y/hub/permissions`) - implement via `createAuthorize` for full checking; a hand-rolled function body cannot correlate a runtime check of `scope` with its return type and needs a cast. Every answer is additionally validated against the scope's permission schema at runtime. Denial is a value: return null (or an object granting nothing) - never throw to deny. A throw is an infrastructure failure: rest requests and the websocket upgrade answer 503 (a branded apiError passes its status through), a websocket recheck disconnects 1013 (transient), never 4401. Must be deterministic per (scope, resourceId, user) between upgrade and recheck - wall-clock-relative grants (`from: now - 30d`) flap connections; compute such bounds when the grant is stored, not when it is read.
 */

/**
 * @template {UserAuthInfo} AuthInfo
 * @param {AuthPlugin<AuthInfo>} authDef
 */
export const createAuthPlugin = authDef => authDef

/**
 * Implement `authorize` as one handler per scope - the shape whose return type TypeScript can
 * verify per scope (inside a single function body, a runtime check of `scope` cannot narrow the
 * return type). Each handler receives the scope's resourceId shape and the caller (null when
 * anonymous) and must return that scope's permission object (or null); scopes without a handler
 * deny.
 *
 * @template {UserAuthInfo} AuthInfo
 * @param {{ [Scope in import('./permissions.js').PermissionScope]?: (resourceId: import('./permissions.js').PermissionResourceId<Scope>, user: AuthInfo|null) => Promise<import('./permissions.js').ToPermissionType<Scope> | null> }} handlers
 * @return {AuthPlugin<AuthInfo>['authorize']}
 */
export const createAuthorize = handlers => async (scope, resourceId, user) => (await handlers[scope]?.(resourceId, user)) ?? null

/**
 * The type of `req.query` when the endpoint method declares no `$query` spec.
 *
 * @typedef {{ [key: string]: any }} ApiQueryAny
 */

/**
 * The request object passed to custom api endpoint handlers (`server.api`). All properties are
 * plain snapshots taken before the handler runs - safe to access at any time. The only exception
 * is `aborted`, which flips to true once the client disconnects.
 *
 * @template [Query=ApiQueryAny]
 * @template [Body=undefined]
 * @typedef {object} ApiRequestBase
 * @property {import('./index.js').YHub} ApiRequestBase.yhub
 * @property {'get'|'post'|'put'|'patch'|'delete'} ApiRequestBase.method
 * @property {string} ApiRequestBase.path - the request path, e.g. '/api/comments/v1/acme/readme'
 * @property {{ [name: string]: string }} ApiRequestBase.params - the named path segments declared via `path`
 * @property {{ [name: string]: string }} ApiRequestBase.headers - lowercased request headers
 * @property {UserAuthInfo|null} ApiRequestBase.authInfo - what `authenticate` returned; null for an anonymous caller
 * @property {boolean} ApiRequestBase.aborted - true once the client disconnected. Check between expensive steps and return early.
 * @property {Query} ApiRequestBase.query - the url query attributes as a plain object. Coerced & validated by the method's `$query` spec when declared; raw strings otherwise. Attributes not declared in the spec pass through as raw strings.
 * @property {Body} ApiRequestBase.body - the request body, decoded by its content type and validated (json: coerced) against the method's `$body` spec when declared; `undefined` otherwise (use `bytes()`/`any()`)
 * @property {() => Promise<Uint8Array<ArrayBuffer>>} ApiRequestBase.bytes - the raw request body
 * @property {() => Promise<any>} ApiRequestBase.any - the request body, lib0-any-decoded
 */

/**
 * @template [Query=ApiQueryAny]
 * @template [Body=undefined]
 * @typedef {ApiRequestBase<Query, Body> & { org: string, docid: string, branch: string, docRef: DocRef, permissions: import('./permissions.js').DocumentPermissionsV1Normalized | null }} ApiDocumentRequest
 */
/**
 * @template [Query=ApiQueryAny]
 * @template [Body=undefined]
 * @typedef {ApiRequestBase<Query, Body> & { org: string, docid: null, branch: null, docRef: null, permissions: import('./permissions.js').OrgPermissionsV1Normalized | null }} ApiOrgRequest
 */
/**
 * @template [Query=ApiQueryAny]
 * @template [Body=undefined]
 * @typedef {ApiRequestBase<Query, Body> & { org: null, docid: null, branch: null, docRef: null, permissions: import('./permissions.js').GlobalPermissionsV1Normalized | null }} ApiGlobalRequest
 */
/**
 * @typedef {ApiDocumentRequest | ApiOrgRequest | ApiGlobalRequest} ApiRequest
 */

/**
 * A method definition of a custom api endpoint: the `handler` plus per-method options. `$query`
 * declares the supported query attributes as a shape object - values are schemas (`s.$number`),
 * literals (`'a'`), or arrays of those (= unions) - or a prebuilt `s.$object(..)` schema. Query
 * values arrive as strings and are coerced to number/boolean where the schema asks for it, then
 * validated before the handler runs - failing requests are answered 400.
 *
 * `$body` (not on `get`) declares the request body the same way. The body is decoded by its
 * content type and passed as `req.body`: `application/json` bodies are coerced against the schema
 * (binary fields arrive as base64 strings), lib0-any bodies express exact types and are validated
 * as-is - failing requests are answered 400 with `code: 'invalid-body'`.
 *
 * @template Req
 * @typedef {{ $query?: { [key: string]: any }, $body?: { [key: string]: any }, handler: (req: Req) => any }} ApiMethodDef
 */

/**
 * The method definitions of a custom api endpoint. Every method - builtin and custom alike - is
 * gated by the `endpoint` facet of the request's permissions before the handler runs: the mask
 * position follows the HTTP verb (`get`→`r`, `post`→`c`, `put`/`patch`→`u`, `delete`→`d`). The
 * semantic facets are the handler's business: a handler that reads or writes the document states
 * the facets it needs on `req.permissions` itself (`checkPermissions(req.permissions, createDocumentPermissions({ ydoc: '-r--' }))`
 * before calling `yhub.getDoc`; `req.permissions` is null when the auth plugin answered null).
 * Likewise identity: `req.authInfo` is null for an anonymous caller - a handler that needs one
 * answers its own 401.
 * Handler return values: a `Response` is written as-is, `null`/`undefined`
 * responds "204 No Content", a string responds as text/plain, a Uint8Array is sent raw
 * (application/octet-stream), `encodedAny(bytes)` sends pre-encoded lib0-any bytes
 * (application/x-lib0any), and anything else is lib0-any-encoded (application/x-lib0any). Object
 * and `encodedAny` results are served as json instead when the request sends
 * `Accept: application/json` - see API.md.
 *
 * @template Req
 * @typedef {object} ApiEndpointMethods
 * @property {ApiMethodDef<Req>} [ApiEndpointMethods.get]
 * @property {ApiMethodDef<Req>} [ApiEndpointMethods.post]
 * @property {ApiMethodDef<Req>} [ApiEndpointMethods.put]
 * @property {ApiMethodDef<Req>} [ApiEndpointMethods.patch]
 * @property {ApiMethodDef<Req>} [ApiEndpointMethods.delete]
 */

/**
 * A custom rest endpoint served at `/{apiPrefix}/{name}/{version}/...` (default prefix: `api`,
 * see `server.apiPrefix`) - see API.md. One name may serve
 * several routes with distinct url depths (e.g. a collection plus an item route via
 * `path: '/:commentId'`). Handlers are typed by `scope`: doc-scoped handlers receive a non-null
 * `docRef`, org-scoped handlers receive `org` only, global handlers neither.
 *
 * Fields: `version` (default: 'v1'), `scope` (default: 'document'), `path` (additional named path
 * segments, e.g. '/:commentId'), `cors` (overrides `server.cors` for this endpoint - `null`
 * disables cors on it). Each method is defined as a `{ $query?, handler }` object - see
 * `ApiMethodDef`. Names of built-in endpoints (`ydoc`, `rollback`, `prune`, `changeset`,
 * `activity`, `ws`) are reserved and refused in any version - one name in the `endpoint`
 * permission facet must mean one route family (`ws` is the websocket route's entry: `r` opens
 * the socket, `u` admits doc updates over it).
 *
 * @typedef {{ name: string, version?: string, scope?: 'document', path?: string, cors?: Partial<CorsConfig>|null } & ApiEndpointMethods<ApiDocumentRequest>} ApiDocumentEndpoint
 */
/**
 * @typedef {{ name: string, version?: string, scope: 'org', path?: string, cors?: Partial<CorsConfig>|null } & ApiEndpointMethods<ApiOrgRequest>} ApiOrgEndpoint
 */
/**
 * @typedef {{ name: string, version?: string, scope: 'global', path?: string, cors?: Partial<CorsConfig>|null } & ApiEndpointMethods<ApiGlobalRequest>} ApiGlobalEndpoint
 */
/**
 * @typedef {ApiDocumentEndpoint | ApiOrgEndpoint | ApiGlobalEndpoint} ApiEndpoint
 */

/**
 * The type of `req.query` for a `$query` spec `Q` - `ApiQueryAny` when no spec is declared.
 *
 * @template Q
 * @typedef {[Q] extends [undefined] ? ApiQueryAny : s.ReadSchemaUnwrapped<Q>} ApiQueryType
 */
/**
 * The type of `req.body` for a `$body` spec `B` - `undefined` when no spec is declared.
 *
 * @template B
 * @typedef {[B] extends [undefined] ? undefined : s.ReadSchemaUnwrapped<B>} ApiBodyType
 */
/**
 * @template {'document'|'org'|'global'} Scope
 * @template Query
 * @template [Body=undefined]
 * @typedef {Scope extends 'document' ? ApiDocumentRequest<Query, Body> : Scope extends 'org' ? ApiOrgRequest<Query, Body> : ApiGlobalRequest<Query, Body>} ApiScopedRequest
 */

/**
 * Define a custom api endpoint (`server.api`) with scope-aware handler typings and a preserved
 * literal name. Purely a typing helper - plain object literals work identically inside the
 * config; use this for endpoints defined in separate modules. When a method declares a `$query`
 * spec (e.g. `get: { $query: { limit: s.$number }, handler }`), that method's `req.query` is
 * typed by the spec; without one it is `{ [key: string]: any }`. Likewise `$body` (not on `get`)
 * types that method's `req.body`.
 *
 * @template {string} Name
 * @template {'document'|'org'|'global'} [Scope='document']
 * @template [QGet=undefined]
 * @template [QPost=undefined]
 * @template [QPut=undefined]
 * @template [QPatch=undefined]
 * @template [QDelete=undefined]
 * @template [BPost=undefined]
 * @template [BPut=undefined]
 * @template [BPatch=undefined]
 * @template [BDelete=undefined]
 * @param {Name} name
 * @param {{ version?: string, scope?: Scope, path?: string, cors?: Partial<CorsConfig>|null, get?: { $query?: QGet, handler: (req: ApiScopedRequest<Scope, ApiQueryType<QGet>>) => any }, post?: { $query?: QPost, $body?: BPost, handler: (req: ApiScopedRequest<Scope, ApiQueryType<QPost>, ApiBodyType<BPost>>) => any }, put?: { $query?: QPut, $body?: BPut, handler: (req: ApiScopedRequest<Scope, ApiQueryType<QPut>, ApiBodyType<BPut>>) => any }, patch?: { $query?: QPatch, $body?: BPatch, handler: (req: ApiScopedRequest<Scope, ApiQueryType<QPatch>, ApiBodyType<BPatch>>) => any }, delete?: { $query?: QDelete, $body?: BDelete, handler: (req: ApiScopedRequest<Scope, ApiQueryType<QDelete>, ApiBodyType<BDelete>>) => any } }} opts
 * @return {ApiEndpoint & { name: Name }}
 */
export const createApiEndpoint = (name, opts) => /** @type {any} */ ({ name, ...opts })

export const $cors = s.$object({
  /**
   * Allowed origin(s). `'*'` allows every origin - it cannot be combined with `credentials`,
   * which browsers reject. An array is an allowlist: the request's `Origin` is echoed back when
   * it matches (the header holds a single value), and `Vary: Origin` is sent so caches don't
   * mix origins up; a single origin behaves as a one-entry allowlist. A request from an origin that doesn't match is denied. An entry may start
   * its host with `*.` - `https://*.example.com` matches every host under `example.com`
   * (subdomains of subdomains included) but never the apex, and ports must be spelled out.
   * Mind that a wildcard on a shared or public suffix (`https://*.co.uk`,
   * `https://*.github.io`) allowlists every site anyone can host under it - see API.md.
   * Websocket upgrades and api requests are origin-gated beyond cors itself: cross-origin is
   * denied unless allowed here or same-origin (see `trustSameOrigin`).
   */
  origin: s.$union(s.$string, s.$array(s.$string)),
  /**
   * Send `Access-Control-Allow-Credentials: true`, letting browsers send cookies and http auth.
   * Requires a concrete `origin`. (default: false)
   */
  credentials: s.$boolean.optional,
  /**
   * Trust browser requests whose `Origin` names the request's own `Host`: they pass the origin
   * gate without being listed in the allowlist. The scheme is not compared - behind a
   * tls-terminating proxy the server sees http while the browser says https (see API.md) - but
   * a browser that sends `Sec-Fetch-Site` (all since 2023) must also report `same-origin` (or
   * `none`), which closes the scheme gap the comparison cannot see. Set
   * to false to enforce the allowlist for every browser origin, same-origin included. Affects
   * only the origin gate on websocket upgrades and api requests - a same-origin response needs
   * no Access-Control header. (default: true)
   */
  trustSameOrigin: s.$boolean.optional,
  /**
   * Request headers browsers may send, as `Access-Control-Allow-Headers` on the preflight.
   * (default: `['Content-Type', 'Authorization']` - `Authorization` is never a "simple" header,
   * and omitting it would fail every authorized browser request at the preflight). A `'*'`
   * entry is accepted without `credentials`, but the Fetch wildcard never covers
   * `Authorization` - list it alongside: `['*', 'Authorization']`.
   */
  allowHeaders: s.$array(s.$string).optional,
  /**
   * Response headers browsers may read, as `Access-Control-Expose-Headers`.
   */
  exposeHeaders: s.$array(s.$string).optional,
  /**
   * Seconds a browser may cache the preflight, as `Access-Control-Max-Age`. A non-negative
   * integer. (default: 3600)
   */
  maxAge: s.$number.optional
})

/**
 * @typedef {s.Unwrap<typeof $cors>} CorsConfig
 */

export const $config = s.$object({
  redis: s.$object({
    url: s.$string,
    prefix: s.$string,
    /**
     * After this timeout, a worker will pick up a task and clean up a stream. (default: 60 seconds)
     */
    taskDebounce: s.$number.optional,
    /**
     * Minimum lifetime of y* update messages in redis streams. (default: 60 seconds)
     */
    minMessageLifetime: s.$number.optional,
    /**
     * TTL for cached API responses in seconds. (default: 5 seconds)
     */
    cacheTtl: s.$number.optional,
    /**
     * Additional options passed to the Redis client.
     * Merged before YHub's required url and socket defaults. Custom scripts are merged with YHub scripts.
     * @type {s.$Optional<s.Schema<Omit<import('@redis/client').RedisClientOptions, 'url'>>>}
     */
    clientOptions: /** @type {s.$Optional<s.Schema<Omit<import('@redis/client').RedisClientOptions, 'url'>>>} */ (s.$any.optional),
    /**
     * Custom socket options passed to the Redis client (e.g. `{ tls: true, rejectUnauthorized: false, ca: '...' }`).
     * Merged into the default socket config (which sets connectTimeout and reconnectStrategy).
     * @type {s.$Optional<s.Schema<import('@redis/client').RedisClientOptions['socket']>>}
     */
    socket: /** @type {s.$Optional<s.Schema<import('@redis/client').RedisClientOptions['socket']>>} */ (s.$any.optional)
  }),
  postgres: s.$string,
  persistence: s.$array($persistencePlugin),
  /**
   * Number of worker threads in the compute pool, which performs CPU-intensive
   * Yjs operations (merging, state vectors, changesets). (default: number of
   * cpus - 1)
   */
  computePoolSize: s.$number.optional,
  /**
   * Maximum time a single task may run. A compute task that exceeds it has its worker thread
   * killed - it can't be cancelled cooperatively - which rejects the task so its caller can
   * retry. A compaction task that exceeds it outside of compute is abandoned by the worker, so
   * that its document is reclaimed by another worker instead of staying leased forever.
   * (default: 30 minutes)
   */
  maxTaskDuration: s.$number.optional,
  events: s.$object({
    docUpdate: s.$lambda(s.$any, s.$instanceOf(Y.Doc), s.$object({ inserts: s.$instanceOf(Y.IdMap), deletes: s.$instanceOf(Y.IdMap) }), s.$undefined)
  }).optional,
  worker: s.$object({
    taskConcurrency: s.$number,
    events: s.$object({
      docUpdate: /** @type {s.$Optional<s.Schema<(event:DocTable<{ gc: true, nongc: true, contentmap: true, contentids: true }> & { docRef: DocRef }) => void>>} */ (s.$function.optional),
      taskStart: /** @type {s.$Optional<s.Schema<(event: { docRef: DocRef, timestamp: number }) => void>>} */ (s.$function.optional),
      taskComplete: /** @type {s.$Optional<s.Schema<(event: { docRef: DocRef, duration: number, error: Error|null }) => void>>} */ (s.$function.optional)
    }).optional
  }).nullable.optional,
  server: s.$object({
    port: s.$number,
    auth: $authPlugin,
    /**
     * Custom rest endpoints served under `/{apiPrefix}/{name}/{version}/...`. See API.md.
     * @type {s.$Optional<s.Schema<Array<ApiEndpoint>>>}
     */
    api: /** @type {s.$Optional<s.Schema<Array<ApiEndpoint>>>} */ (s.$array(s.$objectAny).optional),
    /**
     * First path segment under which all endpoints are served - built-in and custom rest
     * endpoints plus the websocket route `/{apiPrefix}/ws/v1/...` - e.g. 'collaboration' serves
     * everything at `/collaboration/{name}/{version}/...` (default: 'api'). A single path segment.
     */
    apiPrefix: s.$string.optional,
    /**
     * Maximum expected Ydoc size in bytes. Used as baseline to calculate WebSocket
     * maxPayloadLength and maxBackpressure. (default: 500MB)
     */
    maxDocSize: s.$number.optional,
    /**
     * Cross-origin resource sharing. While this is unset, no `Access-Control-*` header is sent
     * and cross-origin websocket upgrades and api requests are denied - only same-origin pages
     * and non-browser clients can use the api. Individual endpoints may override it via their
     * `cors` field. See API.md.
     */
    cors: $cors.nullable.optional
  }).nullable.optional
})

/**
 * @typedef {s.Unwrap<typeof $config>} YHubConfig
 */
