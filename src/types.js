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
 * `purpose` is the `accessPurpose` of a custom api endpoint (`null` when unset). Built-in
 * endpoints and websocket connections don't supply it, so treat `purpose == null` (loose
 * comparison) as "no purpose".
 *
 * `getOrgAccessType` / `getGlobalAccessType` authorize org-/global-scoped custom api endpoints.
 * When missing, requests to endpoints of that scope are denied.
 *
 * @template {UserAuthInfo} AuthInfo
 * @typedef {object} AuthPlugin
 * @property {(req:import('uws').HttpRequest) => Promise<AuthInfo|null>} AuthPlugin.readAuthInfo - return null (or throw) to reject the request with 401
 * @property {(authInfo: AuthInfo, room: Room, purpose?: string|null) => Promise<AccessType>} AuthPlugin.getAccessType:
 * @property {(authInfo: AuthInfo, org: string, purpose?: string|null) => Promise<AccessType>} [AuthPlugin.getOrgAccessType]
 * @property {(authInfo: AuthInfo, purpose?: string|null) => Promise<AccessType>} [AuthPlugin.getGlobalAccessType]
 */

/**
 * @template {UserAuthInfo} AuthInfo
 * @param {AuthPlugin<AuthInfo>} authDef
 */
export const createAuthPlugin = authDef => authDef

/**
 * The request object passed to custom api endpoint handlers (`server.api`). All properties are
 * plain snapshots taken before the handler runs - safe to access at any time. The only exception
 * is `aborted`, which flips to true once the client disconnects.
 *
 * @typedef {object} ApiRequestBase
 * @property {import('./index.js').YHub} ApiRequestBase.yhub
 * @property {'get'|'post'|'put'|'patch'|'delete'} ApiRequestBase.method
 * @property {string} ApiRequestBase.path - the request path, e.g. '/api/v1/comments/acme/readme'
 * @property {{ [name: string]: string }} ApiRequestBase.params - the named path segments declared via `path`
 * @property {{ [name: string]: string }} ApiRequestBase.headers - lowercased request headers
 * @property {UserAuthInfo} ApiRequestBase.authInfo
 * @property {'r'|'rw'} ApiRequestBase.accessType
 * @property {boolean} ApiRequestBase.aborted - true once the client disconnected. Check between expensive steps and return early.
 * @property {URLSearchParams} ApiRequestBase.query
 * @property {() => Promise<Uint8Array<ArrayBuffer>>} ApiRequestBase.bytes - the raw request body
 * @property {() => Promise<any>} ApiRequestBase.any - the request body, lib0-any-decoded
 */

/**
 * @typedef {ApiRequestBase & { org: string, docid: string, branch: string, room: Room }} ApiDocRequest
 */
/**
 * @typedef {ApiRequestBase & { org: string, docid: null, branch: null, room: null }} ApiOrgRequest
 */
/**
 * @typedef {ApiRequestBase & { org: null, docid: null, branch: null, room: null }} ApiGlobalRequest
 */
/**
 * @typedef {ApiDocRequest | ApiOrgRequest | ApiGlobalRequest} ApiRequest
 */

/**
 * The method handlers of a custom api endpoint. `get` requires 'r' access, all other methods
 * require 'rw'. Handler return values: a `Response` is written as-is, `null`/`undefined`
 * responds "204 No Content", a string responds as text/plain, a Uint8Array is sent raw
 * (application/octet-stream), and anything else is lib0-any-encoded (application/x-lib0any).
 *
 * @template Req
 * @typedef {object} ApiEndpointMethods
 * @property {(req: Req) => any} [ApiEndpointMethods.get]
 * @property {(req: Req) => any} [ApiEndpointMethods.post]
 * @property {(req: Req) => any} [ApiEndpointMethods.put]
 * @property {(req: Req) => any} [ApiEndpointMethods.patch]
 * @property {(req: Req) => any} [ApiEndpointMethods.delete]
 */

/**
 * A custom rest endpoint served at `/api/{version}/{name}/...` - see API.md. One name may serve
 * several routes with distinct url depths (e.g. a collection plus an item route via
 * `path: '/:commentId'`). Handlers are typed by `scope`: doc-scoped handlers receive a non-null
 * `room`, org-scoped handlers receive `org` only, global handlers neither.
 *
 * Fields: `version` (default: 'v1'), `scope` (default: 'doc'), `path` (additional named path
 * segments, e.g. '/:commentId'), `accessPurpose` (forwarded as `purpose` to the auth access
 * callback).
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
 * Define a custom api endpoint (`server.api`) with scope-aware handler typings and a preserved
 * literal name. Purely a typing helper - plain object literals work identically inside the
 * config; use this for endpoints defined in separate modules.
 *
 * @template {string} Name
 * @template {'doc'|'org'|'global'} [Scope='doc']
 * @param {Name} name
 * @param {{ version?: string, scope?: Scope, path?: string, accessPurpose?: string } & ApiEndpointMethods<Scope extends 'doc' ? ApiDocRequest : Scope extends 'org' ? ApiOrgRequest : ApiGlobalRequest>} opts
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
     * Custom rest endpoints served under `/api/{version}/{name}/...`. See API.md.
     * @type {s.$Optional<s.Schema<Array<ApiEndpoint>>>}
     */
    api: /** @type {s.$Optional<s.Schema<Array<ApiEndpoint>>>} */ (s.$array(s.$objectAny).optional),
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
