/**
 * Generic blob storage persistence plugin for yhub.
 *
 * Drop-in alternative to {@link S3PersistenceV1} that works with any cloud
 * storage backend (Azure Blob Storage, Google Cloud Storage, etc.). Instead of
 * being tied to a specific SDK, the caller provides a simple {@link BlobAdapter}
 * with four operations (`put`, `get`, `del`, and optionally `init`).
 *
 * Behavior is identical to S3PersistenceV1:
 * - Only `main`-branch assets are offloaded to blob storage; other branches
 *   remain in PostgreSQL.
 * - Assets are encoded with `lib0/buffer.encodeAny` and decoded on retrieval.
 * - Object keys use the canonical `t.assetIdToString()` format
 *   (`id:ydoc:v1/{org}/{docid}/{branch}/{gc}/{t}`).
 * - Deletion is delayed 10 seconds to prevent stale reads from concurrent
 *   clients that still reference the old object.
 *
 * @example <caption>Azure Blob Storage</caption>
 * import { BlobPersistence } from '@y/hub/plugins/blob'
 * import { BlobServiceClient } from '@azure/storage-blob' // your dependency
 *
 * const client = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING)
 * const container = client.getContainerClient('yhub')
 *
 * const plugin = new BlobPersistence('AzureBlob:v1', {
 *   init: () => container.createIfNotExists(),
 *   put: (path, data) => container.getBlockBlobClient(path).upload(data, data.length),
 *   get: async (path) => {
 *     try {
 *       const resp = await container.getBlockBlobClient(path).download()
 *       const chunks = []
 *       for await (const chunk of resp.readableStreamBody) chunks.push(chunk)
 *       return Buffer.concat(chunks)
 *     } catch (e) {
 *       if (e.statusCode === 404) return null
 *       throw e
 *     }
 *   },
 *   del: (path) => container.getBlockBlobClient(path).deleteIfExists()
 * })
 *
 * createYHub({ persistence: [plugin], ... })
 *
 * @example <caption>Google Cloud Storage</caption>
 * import { BlobPersistence } from '@y/hub/plugins/blob'
 * import { Storage } from '@google-cloud/storage' // your dependency
 *
 * const bucket = new Storage({ projectId: process.env.GCS_PROJECT_ID })
 *   .bucket(process.env.GCS_BUCKET)
 *
 * const plugin = new BlobPersistence('GCS:v1', {
 *   init: async () => { const [exists] = await bucket.exists(); if (!exists) await bucket.create() },
 *   put: (path, data) => bucket.file(path).save(data),
 *   get: async (path) => {
 *     try { const [data] = await bucket.file(path).download(); return data }
 *     catch (e) { if (e.code === 404) return null; throw e }
 *   },
 *   del: (path) => bucket.file(path).delete({ ignoreNotFound: true })
 * })
 *
 * createYHub({ persistence: [plugin], ... })
 *
 * @module
 */

import * as t from '../types.js'
import * as buffer from 'lib0/buffer'
import { logger } from '../logger.js'

const log = logger.child({ module: 'blob' })

/**
 * Adapter interface that the caller must implement for their cloud storage
 * backend. yhub calls these methods — all cloud-specific concerns (SDK setup,
 * authentication, retries, transient-error handling) live in the adapter.
 *
 * @typedef {{
 *   put: (path: string, data: Buffer) => Promise<void>,
 *   get: (path: string) => Promise<Buffer|null>,
 *   del: (path: string) => Promise<void>,
 *   init?: () => Promise<void>
 * }} BlobAdapter
 *
 * @property {function(string, Buffer): Promise<void>} put
 *   Store a blob at `path`. The caller is responsible for retries on transient
 *   errors (cloud-specific error codes differ across providers).
 * @property {function(string): Promise<Buffer|null>} get
 *   Retrieve a blob by `path`. Must return `null` when the object does not
 *   exist (the caller maps provider-specific 404s to `null`).
 * @property {function(string): Promise<void>} del
 *   Delete a blob by `path`. Must not throw if the object is already missing.
 * @property {function(): Promise<void>} [init]
 *   Optional one-time setup (e.g. create a container or bucket). Called once
 *   during yhub startup.
 */

/**
 * Generic blob persistence plugin. Pass any {@link BlobAdapter} to offload
 * main-branch assets to a cloud object store without adding cloud SDK
 * dependencies to yhub itself.
 *
 * @implements {t.PersistencePlugin}
 */
export class BlobPersistence {
  /**
   * @param {string} pluginId
   *   Unique identifier for this plugin instance, used to tag stored assets so
   *   they can be retrieved by the correct plugin later. Use a descriptive,
   *   versioned string (e.g. `'AzureBlob:v1'`, `'GCS:v1'`).
   * @param {BlobAdapter} adapter
   *   Caller-provided adapter implementing the four blob operations.
   */
  constructor (pluginId, adapter) {
    this._pluginId = pluginId
    this._adapter = adapter
  }

  get pluginid () {
    return this._pluginId
  }

  async init () {
    await this._adapter.init?.()
  }

  /**
   * Encode and store `asset` in blob storage. Only main-branch assets are
   * offloaded; non-main branches return `null` (kept in PostgreSQL).
   *
   * @param {t.AssetId} assetId
   * @param {t.Asset} asset
   * @return {Promise<t.RetrievableAsset?>}
   */
  async store (assetId, asset) {
    if (assetId.branch === 'main') {
      const path = t.assetIdToString(assetId)
      const data = Buffer.from(buffer.encodeAny(asset))
      await this._adapter.put(path, data)
      return { type: 'asset:retrievable:v1', plugin: this._pluginId }
    }
    return null
  }

  /**
   * Retrieve and decode an asset previously stored by this plugin. Returns
   * `null` if `assetInfo` doesn't belong to this plugin or the blob is missing.
   *
   * @param {t.AssetId} assetId
   * @param {t.Asset} assetInfo
   * @return {Promise<t.Asset?>}
   */
  async retrieve (assetId, assetInfo) {
    if (assetInfo.type === 'asset:retrievable:v1' && assetInfo.plugin === this._pluginId) {
      const path = t.assetIdToString(assetId)
      const data = await this._adapter.get(path)
      return data && t.$asset.expect(buffer.decodeAny(data))
    }
    return null
  }

  /**
   * Schedule deletion of a previously stored blob. Deletion is delayed by 10
   * seconds to avoid races with clients that may still be reading stale
   * references. Returns `false` if `assetInfo` doesn't belong to this plugin.
   *
   * @param {t.AssetId} assetId
   * @param {t.Asset} assetInfo
   * @return {Promise<boolean>}
   */
  async delete (assetId, assetInfo) {
    if (assetInfo.type !== 'asset:retrievable:v1' || assetInfo.plugin !== this._pluginId) {
      return false
    }
    const path = t.assetIdToString(assetId)
    setTimeout(() => {
      this._adapter.del(path).catch(err => log.error({ err, path }, 'error deleting object'))
    }, 10_000)
    return true
  }
}
