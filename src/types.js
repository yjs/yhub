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
 * A Message contains information w want to distribute to clients. They are usually put on the
 * distribution stream.
 */
export const $message = s.$union($updateMessage, $awarenessMessage)

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
 *   awareness: IfHasConf<Include, 'awareness', import('@y/protocols/awareness').Awareness>
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
  getAccessType: /** @type {any} */ (s.$function)
}))

/**
 * @typedef {{ userid: string }} UserAuthInfo
 */

/**
 * @template {UserAuthInfo} AuthInfo
 * @typedef {object} AuthPlugin
 * @property {(req:import('uws').HttpRequest) => Promise<AuthInfo>} AuthPlugin.readAuthInfo
 * @property {(authInfo: AuthInfo, room: Room) => Promise<AccessType>} AuthPlugin.getAccessType:
 */

/**
 * @template {UserAuthInfo} AuthInfo
 * @param {AuthPlugin<AuthInfo>} authDef
 */
export const createAuthPlugin = authDef => authDef

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
    minMessageLifetime: s.$number.optional
  }),
  postgres: s.$string,
  persistence: s.$array($persistencePlugin),
  events: s.$object({
    docUpdate: s.$lambda(s.$any, s.$instanceOf(Y.Doc), s.$instanceOf(Y.Attributions), s.$undefined)
  }).optional,
  worker: s.$object({
    taskConcurrency: s.$number,
    events: s.$object({
      docUpdate: /** @type {s.$Optional<s.Schema<(doctable:DocTable<{ gc: true, nongc: true, contentmap: true, contentids: true }>) => void>>} */ (s.$function.optional)
    }).optional
  }).nullable.optional,
  server: s.$({
    port: s.$number,
    auth: $authPlugin
  }).nullable.optional
})

/**
 * @typedef {s.Unwrap<typeof $config>} YHubConfig
 */
