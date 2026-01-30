import * as t from '../types.js'
import * as buffer from 'lib0/buffer'
import { Client as S3Client } from 'minio'

/**
 * @typedef {{ bucket: string, endPoint: string, port: number, useSSL: boolean, accessKey: string, secretKey: string }} S3Conf
 */

/**
 * @implements {t.PersistencePlugin}
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
   * @param {t.Asset} assetInfo
   * @return {Promise<t.Asset?>}
   */
  async retrieve (assetId, assetInfo) {
    if (assetInfo.type === 'asset:retrievable:v1' && assetInfo.plugin === this.pluginid) {
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
   * @param {t.Asset} assetInfo
   * @return {Promise<boolean>}
   */
  async delete (assetId, assetInfo) {
    if (assetInfo.type !== 'asset:retrievable:v1' || assetInfo.plugin !== this.pluginid) {
      return false
    }
    const path = t.assetIdToString(assetId)
    await this.s3client.removeObject(this.bucket, path)
    return true
  }
}
