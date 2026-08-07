import * as Y from '@y/y'
import * as s from 'lib0/schema'

export const $accessType = s.$union(s.$literal('r'), s.$literal('rw'), s.$null)

/**
 * @typedef {s.Unwrap<typeof $accessType>} AccessType
 */

/**
 * @param {AccessType} [accessType]
 */
export const hasReadAccess = accessType => accessType === 'r' || accessType === 'rw'

/**
 * @param {AccessType} [accessType]
 */
export const hasWriteAccess = accessType => accessType === 'rw'

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
 * Directive to re-check permissions of the websocket connections of a room (see
 * `YHub.recheckAuth`). `users` is an array of authInfo matchers — `null` matches every
 * connection. `forceDisconnect` disconnects matching connections without re-checking access.
 */
export const $authCheckMessage = s.$({
  type: s.$literal('auth:check:v1'),
  users: s.$array(s.$union(s.$string, s.$objectAny)).nullable,
  forceDisconnect: s.$boolean
})

/**
 * A Message contains information w want to distribute to clients. They are usually put on the
 * distribution stream.
 */
export const $message = s.$union($updateMessage, $awarenessMessage, $pruneMessage, $authCheckMessage)

/**
 * @typedef {s.Unwrap<typeof $message>} Message
 */

export const $room = s.$object({ org: s.$string, docid: s.$string, branch: s.$string })

/**
 * @typedef {s.Unwrap<typeof $room>} Room
 */

export const $compactTask = s.$({
  type: s.$literal('compact'),
  room: {
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
 *   gcDoc: IfHasConf<Include, 'gc', Uint8Array<ArrayBuffer>>,
 *   nongcDoc: IfHasConf<Include, 'nongc', Uint8Array<ArrayBuffer>>,
 *   contentmap: IfHasConf<Include, 'contentmap', Uint8Array<ArrayBuffer>>,
 *   references: IfHasConf<Include, 'references', Array<{ assetId: AssetId, asset: Asset }>>,
 *   contentids: IfHasConf<Include, 'contentids', Uint8Array<ArrayBuffer>>,
 *   awareness: IfHasConf<Include, 'awareness', Uint8Array<ArrayBuffer>>,
 *   authChecks: Array<s.Unwrap<typeof $authCheckMessage>>
 * }, 1>} DocTable
 */

/**
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
  readAuthInfo: /** @type {any} */ (s.$function),
  getAccessType: /** @type {any} */ (s.$function),
  getOrgAccessType: /** @type {any} */ (s.$function).optional,
  getGlobalAccessType: /** @type {any} */ (s.$function).optional
}))

/**
 * @typedef {{ userid: string }} UserAuthInfo
 */

/**
 * `purpose` is the `accessPurpose` of a custom api endpoint — `null` when unset and for
 * built-in endpoints and websocket connections.
 *
 * `getOrgAccessType` / `getGlobalAccessType` authorize org-/global-scoped custom api endpoints.
 * When missing, requests to endpoints of that scope are denied.
 *
 * @template {UserAuthInfo} AuthInfo
 * @typedef {object} AuthPlugin
 * @property {(req:import('uws').HttpRequest) => Promise<AuthInfo|null>} AuthPlugin.readAuthInfo - return null (or throw) to reject the request with 401. Throw an `apiError(503, ...)` (from `@y/hub`) to signal a temporary auth-backend outage - rest requests and the websocket upgrade respond with that status instead.
 * @property {(authInfo: AuthInfo, room: Room, purpose: string|null) => Promise<AccessType>} AuthPlugin.getAccessType - signal denial by returning null, not by throwing: an error thrown during a websocket recheck disconnects with the transient close code 1013, not the revoke code 4401.
 * @property {(authInfo: AuthInfo, org: string, purpose: string|null) => Promise<AccessType>} [AuthPlugin.getOrgAccessType]
 * @property {(authInfo: AuthInfo, purpose: string|null) => Promise<AccessType>} [AuthPlugin.getGlobalAccessType]
 */

/**
 * @template {UserAuthInfo} AuthInfo
 * @param {AuthPlugin<AuthInfo>} authDef
 */
export const createAuthPlugin = authDef => authDef

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
 * @property {UserAuthInfo} ApiRequestBase.authInfo
 * @property {'r'|'rw'} ApiRequestBase.accessType
 * @property {boolean} ApiRequestBase.aborted - true once the client disconnected. Check between expensive steps and return early.
 * @property {Query} ApiRequestBase.query - the url query attributes as a plain object. Coerced & validated by the method's `$query` spec when declared; raw strings otherwise. Attributes not declared in the spec pass through as raw strings.
 * @property {Body} ApiRequestBase.body - the request body, decoded by its content type and validated (json: coerced) against the method's `$body` spec when declared; `undefined` otherwise (use `bytes()`/`any()`)
 * @property {() => Promise<Uint8Array<ArrayBuffer>>} ApiRequestBase.bytes - the raw request body
 * @property {() => Promise<any>} ApiRequestBase.any - the request body, lib0-any-decoded
 */

/**
 * @template [Query=ApiQueryAny]
 * @template [Body=undefined]
 * @typedef {ApiRequestBase<Query, Body> & { org: string, docid: string, branch: string, room: Room }} ApiDocRequest
 */
/**
 * @template [Query=ApiQueryAny]
 * @template [Body=undefined]
 * @typedef {ApiRequestBase<Query, Body> & { org: string, docid: null, branch: null, room: null }} ApiOrgRequest
 */
/**
 * @template [Query=ApiQueryAny]
 * @template [Body=undefined]
 * @typedef {ApiRequestBase<Query, Body> & { org: null, docid: null, branch: null, room: null }} ApiGlobalRequest
 */
/**
 * @typedef {ApiDocRequest | ApiOrgRequest | ApiGlobalRequest} ApiRequest
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
 * The method definitions of a custom api endpoint. `get` requires 'r' access, all other methods
 * require 'rw'. Handler return values: a `Response` is written as-is, `null`/`undefined`
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
 * `room`, org-scoped handlers receive `org` only, global handlers neither.
 *
 * Fields: `version` (default: 'v1'), `scope` (default: 'doc'), `path` (additional named path
 * segments, e.g. '/:commentId'), `accessPurpose` (forwarded as `purpose` to the auth access
 * callback). Each method is defined as a `{ $query?, handler }` object - see `ApiMethodDef`.
 *
 * @typedef {{ name: string, version?: string, scope?: 'doc', path?: string, accessPurpose?: string } & ApiEndpointMethods<ApiDocRequest>} ApiDocEndpoint
 */
/**
 * @typedef {{ name: string, version?: string, scope: 'org', path?: string, accessPurpose?: string } & ApiEndpointMethods<ApiOrgRequest>} ApiOrgEndpoint
 */
/**
 * @typedef {{ name: string, version?: string, scope: 'global', path?: string, accessPurpose?: string } & ApiEndpointMethods<ApiGlobalRequest>} ApiGlobalEndpoint
 */
/**
 * @typedef {ApiDocEndpoint | ApiOrgEndpoint | ApiGlobalEndpoint} ApiEndpoint
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
 * @template {'doc'|'org'|'global'} Scope
 * @template Query
 * @template [Body=undefined]
 * @typedef {Scope extends 'doc' ? ApiDocRequest<Query, Body> : Scope extends 'org' ? ApiOrgRequest<Query, Body> : ApiGlobalRequest<Query, Body>} ApiScopedRequest
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
 * @template {'doc'|'org'|'global'} [Scope='doc']
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
 * @param {{ version?: string, scope?: Scope, path?: string, accessPurpose?: string, get?: { $query?: QGet, handler: (req: ApiScopedRequest<Scope, ApiQueryType<QGet>>) => any }, post?: { $query?: QPost, $body?: BPost, handler: (req: ApiScopedRequest<Scope, ApiQueryType<QPost>, ApiBodyType<BPost>>) => any }, put?: { $query?: QPut, $body?: BPut, handler: (req: ApiScopedRequest<Scope, ApiQueryType<QPut>, ApiBodyType<BPut>>) => any }, patch?: { $query?: QPatch, $body?: BPatch, handler: (req: ApiScopedRequest<Scope, ApiQueryType<QPatch>, ApiBodyType<BPatch>>) => any }, delete?: { $query?: QDelete, $body?: BDelete, handler: (req: ApiScopedRequest<Scope, ApiQueryType<QDelete>, ApiBodyType<BDelete>>) => any } }} opts
 * @return {ApiEndpoint & { name: Name }}
 */
export const createApiEndpoint = (name, opts) => /** @type {any} */ ({ name, ...opts })

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
     * TTL for cached API responses in seconds. (default: 10 seconds)
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
  events: s.$object({
    docUpdate: s.$lambda(s.$any, s.$instanceOf(Y.Doc), s.$object({ inserts: s.$instanceOf(Y.IdMap), deletes: s.$instanceOf(Y.IdMap) }), s.$undefined)
  }).optional,
  worker: s.$object({
    taskConcurrency: s.$number,
    events: s.$object({
      docUpdate: /** @type {s.$Optional<s.Schema<(doctable:DocTable<{ gc: true, nongc: true, contentmap: true, contentids: true }>) => void>>} */ (s.$function.optional),
      taskStart: /** @type {s.$Optional<s.Schema<(event: { room: Room, timestamp: number }) => void>>} */ (s.$function.optional),
      taskComplete: /** @type {s.$Optional<s.Schema<(event: { room: Room, duration: number, error: Error|null }) => void>>} */ (s.$function.optional)
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
    maxDocSize: s.$number.optional
  }).nullable.optional
})

/**
 * @typedef {s.Unwrap<typeof $config>} YHubConfig
 */
