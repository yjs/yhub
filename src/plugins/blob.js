import * as t from '../types.js'
import * as buffer from 'lib0/buffer'
import { logger } from '../logger.js'

const log = logger.child({ module: 'blob' })

/**
 * @typedef {{
 *   put: (path: string, data: Buffer) => Promise<void>,
 *   get: (path: string) => Promise<Buffer|null>,
 *   del: (path: string) => Promise<void>,
 *   init?: () => Promise<void>
 * }} BlobAdapter
 */

/**
 * @implements {t.PersistencePlugin}
 */
export class BlobPersistence {
  /**
   * @param {string} pluginId - Unique identifier (e.g. 'AzureBlob:v1', 'GCS:v1')
   * @param {BlobAdapter} adapter
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
