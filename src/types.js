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

export const $yhubWorkerConf = s.$({
  taskConcurrency: s.$number,
  callbacks: {
    compact: /** @type {s.Schema<(doctable:DocTable<{ gc: true, nongc: true, contentmap: true, contentids: true }>) => void>} */ (s.$function)
  }
})

/**
 * @typedef {s.Unwrap<typeof $yhubWorkerConf>} YHubWorkerConf
 */

/**
 * @typedef {s.Unwrap<typeof $message>} Message
 */

/**
 * @typedef {{ org: string, docid: string, branch: string }} Room
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
 * @template {{ gc?: boolean, nongc?: boolean, contentmap?: boolean, references?: boolean, contentids?: boolean }} [Include=any]
 * @typedef {{ lastClock: string, lastPersistedClock: string, gcDoc: Include['gc'] extends true ? Uint8Array<ArrayBuffer> : null, nongcDoc: Include['nongc'] extends true ? Uint8Array<ArrayBuffer> : null, contentmap: Include['contentmap'] extends true ? Uint8Array<ArrayBuffer> : null, references: Include['references'] extends true ? Array<{ assetId: AssetId, asset: Asset }> : null, contentids: Include['contentids'] extends true ? Uint8Array<ArrayBuffer> : null }} DocTable
 */
