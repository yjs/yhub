import * as t from '../types.js'
import * as buffer from 'lib0/buffer'
import { Client as S3Client } from 'minio'
import { Readable } from 'stream'
import http from 'http'
import https from 'https'

/**
 * @typedef {{ bucket: string, endPoint: string, port: number, useSSL: boolean, accessKey: string, secretKey: string }} S3Conf
 */

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'])
const TRANSIENT_RE = /ECONNRESET|socket hang up|EPIPE/i
const S3_PART_SIZE = 5 * 1024 * 1024

/**
 * Transient errors are temporary network failures where retrying the same request is expected to
 * succeed (e.g. a keepalive connection dropped by the server, a momentary timeout, or throttling).
 *
 * @param {unknown} err
 */
const isTransient = (err) => {
  if (!(err instanceof Error)) return false
  const code = /** @type {any} */ (err).code
  const status = /** @type {any} */ (err).statusCode
  return TRANSIENT_CODES.has(code) ||
    TRANSIENT_RE.test(code) ||
    TRANSIENT_RE.test(err.message) ||
    status === 503 ||
    status === 429
}

/**
 * @implements {t.PersistencePlugin}
 */
export class S3PersistenceV1 {
  /**
   * @param {S3Conf} s3conf
   */
  constructor (s3conf) {
    this.bucket = s3conf.bucket
    const Agent = s3conf.useSSL ? https.Agent : http.Agent
    this._agent = new Agent({ keepAlive: true, keepAliveMsecs: 30_000 })
    this.s3client = new S3Client({ ...s3conf, transportAgent: this._agent, partSize: S3_PART_SIZE })
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
      const file = Buffer.from(buffer.encodeAny(asset))
      const put = () => this.s3client.putObject(this.bucket, path, Readable.from(file), file.length)
      try {
        await put()
      } catch (e) {
        if (!isTransient(e)) throw e
        await put()
      }
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
      const get = async () => {
        try {
          const stream = await this.s3client.getObject(this.bucket, path)
          const chunks = []
          for await (const chunk of stream) {
            chunks.push(chunk)
          }
          return Buffer.concat(chunks)
        } catch (e) {
          if (/** @type {any} */ (e)?.code === 'NoSuchKey') return null
          throw e
        }
      }
      let data
      try {
        data = await get()
      } catch (e) {
        if (!isTransient(e)) throw e
        data = await get()
      }
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
    if (assetInfo.type !== 'asset:retrievable:v1' || assetInfo.plugin !== this.pluginid) {
      return false
    }
    const path = t.assetIdToString(assetId)
    setTimeout(() => {
      // delete at some point later, avoiding issues of clients pulling from stale data
      // @todo it would be nice to implement a worker that finds unused s3 docs and deletes them
      this.s3client.removeObject(this.bucket, path)
    }, 10_000)
    return true
  }
}
