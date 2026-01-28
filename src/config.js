import * as Y from '@y/y'
import * as s from 'lib0/schema'
import * as api from './api.js'
import { Client as S3Client } from 'minio'
import * as buffer from 'lib0/buffer'
import * as t from './types.js'

/**
 * @typedef {object} Plugin
 * @property {(api: api.Api)=>void} [Plugin.init] Called once when initializing the database
 */

/**
 * @typedef {object} PersistencePlugin
 * @property {null|((api: api.Api)=>Promise<any>?)} [PersistPlugin.init]
 * @property {null|((assetId: t.AssetId, asset: t.Asset)=>Promise<t.RetrievableAsset?>)} [PersistPlugin.store]
 * @property {null|((assetId: t.AssetId, assetInfo: t.Asset)=>Promise<t.Asset?>)} [PersistPlugin.retrieve]
 * @property {null|((assetId: t.AssetId, assetInfo: t.Asset)=>Promise<boolean>)} [PersistPlugin.delete]
 */

/**
 * @type {s.Schema<PersistencePlugin>}
 */
export const $persistencePlugin = s.$object({
  init: s.$lambda(s.$instanceOf(api.Api), s.$any),
  store: s.$lambda(s.$any).nullable.optional,
  retrieve: s.$lambda(s.$any).nullable.optional
})

export const $redisConfig = s.$object({
  url: s.$string,
  prefix: s.$string,
  /**
   * After this timeout, a worker will pick up a task and clean up a stream. (default: 10 seconds)
   */
  taskDebounce: s.$number,
  /**
   * Minimum lifetime of y* update messages in redis streams. (default: 1 minute)
   */
  minMessageLifetime: s.$number
})

/**
 * @typedef {s.Unwrap<typeof $redisConfig>} RedisConfig
 */

export const $config = s.$({
  redis: $redisConfig,
  postgres: s.$string,
  log: s.$any,
  persistence: s.$array($persistencePlugin),
  events: s.$object({
    docUpdate: s.$lambda(s.$instanceOf(api.Api), s.$instanceOf(Y.Doc), s.$instanceOf(Y.Attributions), s.$undefined),
  })
})

/**
 * @typedef {s.Unwrap<typeof $config>} YHubConfig
 */

/**
 * @typedef {{ bucket: string, endPoint: string, port: number, useSSL: boolean, accessKey: string, secretKey: string }} S3Conf
 */

/**
 * @implements {PersistencePlugin}
 */
export class S3PersistenceV1 {
  /**
   * @param {S3Conf} s3conf
   */
  constructor (s3conf) {
    this.bucket = s3conf.bucket
    this.s3client = new S3Client(s3conf)
  }

  get pluginid () {
    return 'S3Persistence:v1'
  }

  async init () {
    console.log(`[init ${this.pluginid}] Checking if S3 bucket '${this.bucket}' exists...`)
    const exists = await this.s3client.bucketExists(this.bucket)
    if (!exists) {
      console.log(`[init ${this.pluginid}] Creating S3 bucket '${this.bucket}'...`)
      await this.s3client.makeBucket(this.bucket)
      console.log(`[init ${this.pluginid}] ✓ S3 bucket '${this.bucket}' created`)
    } else {
      console.log(`[init ${this.pluginid}] ✓ S3 bucket '${this.bucket}' already exists`)
    }
  }

  /**
   * @param {t.AssetId} assetId
   * @param {t.Asset} asset
   * @return {Promise<t.RetrievableAsset?>}
   */
  async store (assetId, asset) {
    if (assetId.branch === 'main') {
      const path = t.assetIdToString(assetId)
      const file = buffer.encodeAny(asset)
      await this.s3client.putObject(this.bucket, path, Buffer.from(file))
      return {
        type: 'asset:retrievable:v1',
        plugin: this.pluginid
      }
    }
    return null
  }

  /**
   * @param {t.AssetId} assetId
   * @param {t.RetrievableAsset} assetInfo
   * @return {Promise<t.Asset?>}
   */
  async retrieve (assetId, assetInfo) {
    if (assetInfo.plugin === this.pluginid) {
      const path = t.assetIdToString(assetId)
      const stream = await this.s3client.getObject(this.bucket, path)
      const chunks = []
      for await (const chunk of stream) {
        chunks.push(chunk)
      }
      const data = Buffer.concat(chunks)
      const decoded = t.$asset.expect(buffer.decodeAny(data))
      return decoded
    }
    return null
  }

  /**
   * @param {t.AssetId} assetId
   * @param {t.RetrievableAsset} assetInfo
   * @return {Promise<boolean>}
   */
  async delete (assetId, assetInfo) {
    if (assetInfo.plugin !== this.pluginid) {
      return false
    }
    const path = t.assetIdToString(assetId)
    await this.s3client.removeObject(this.bucket, path)
    return true
  }
}



