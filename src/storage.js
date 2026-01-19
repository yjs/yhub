import * as Y from '@y/y'
import postgres from 'postgres'
import * as error from 'lib0/error'
import * as s from 'lib0/schema'
import * as buffer from 'lib0/buffer'
import { Client as S3Client } from 'minio'
import * as random from 'lib0/random'
import * as promise from 'lib0/promise'

/**
 * @param {string} postgresUrl - postgres://username:password@host:port/database
 * @param {{ bucket: string, endPoint: string, port: number, useSSL: boolean, accessKey: string, secretKey: string }} s3conf
 */
export const createStorage = async (postgresUrl, s3conf) => {
  // If a specific database is requested, ensure it exists
  const sql = postgres(postgresUrl, {})
  try {
    await sql`SELECT 1 as connected`
  } catch (err) {
    throw new Error(`Can't connect to postgres. url: ${postgresUrl}.\n${err}`)
  }
  const s3client = new S3Client(s3conf)
  return new Storage(sql, s3client, s3conf.bucket)
}

/**
 * For future compatibility we encode all updates using any-encoding with the below schema.
 */
const $yUpdate = s.$([{ type: s.$literal('update:v1'), update: s.$uint8Array }, { type: s.$literal('s3:update:v1'), path: s.$string }])

/**
 * @typedef {s.Unwrap<typeof $yUpdate>} YUpdate
 */

const $s3YUpdate = s.$([{ type: s.$literal('update:v1'), update: s.$uint8Array }])

/**
 * This is what is stored in s3 documents - using lib0's any-encoding
 * @typedef {s.Unwrap<typeof $s3YUpdate>} S3YUpdate
 */

/**
 * @param {S3Client} s3client
 * @param {string} s3bucket
 * @param {string} org
 * @param {string} docid
 * @param {Y.Doc} ydoc
 * @return {Promise<YUpdate>}
 */
const storeInS3 = async (s3client, s3bucket, org, docid, ydoc) => {
  const path = `${org}/${docid}-${random.uint32().toString(16).slice(2)}`
  const file = buffer.encodeAny($s3YUpdate.expect({
    type: 'update:v1',
    update: Y.encodeStateAsUpdate(ydoc)
  }))
  await s3client.putObject(s3bucket, path, Buffer.from(file))
  return {
    type: 's3:update:v1',
    path
  }
}

/**
 * @param {S3Client} s3client
 * @param {string} s3bucket
 * @param {YUpdate} yupdate
 */
const readYUpdateToV1 = async (s3client, s3bucket, yupdate) => {
  switch (yupdate.type) {
    case 'update:v1': return yupdate.update
    case 's3:update:v1': {
      try {
        const stream = await s3client.getObject(s3bucket, yupdate.path)
        const chunks = []
        for await (const chunk of stream) {
          chunks.push(chunk)
        }
        const data = Buffer.concat(chunks)
        const decoded = $s3YUpdate.expect(buffer.decodeAny(data))
        s.$literal('update:v1').validate(decoded.type)
        return decoded.update
      } catch (err) {
        console.warn(`Error retrieving document via S3 - indicating data loss. bucket: ${s3bucket}, update: ${JSON.stringify(yupdate)}`)
        return Y.encodeStateAsUpdate(new Y.Doc()) // return empty update
      }
    }
  }
  s.$never.expect(yupdate)
}

/**
 * A Storage implementation that persists documents in PostgreSQL.
 *
 * You probably want to adapt this to your own needs.
 */
export class Storage {
  /**
   * @param {postgres.Sql} sql
   * @param {S3Client} s3client
   * @param {string} s3bucket
   */
  constructor (sql, s3client, s3bucket) {
    this.sql = sql
    this.s3client = s3client
    this.s3bucket = s3bucket
  }

  /**
   * @param {string} org
   * @param {string} docid
   * @param {Y.Doc} ydoc
   * @param {Y.ContentMap?} yContentMap
   * @param {Object} opts
   * @param {boolean} [opts.gc]
   * @param {string} [opts.branch]
   * @returns {Promise<void>}
   */
  async persistDoc (org, docid, ydoc, yContentMap, { gc = true, branch = 'main' } = {}) {
    const yupdate = await storeInS3(this.s3client, this.s3bucket, org, docid, ydoc)
    const encodedUpdate = buffer.encodeAny($yUpdate.expect(yupdate))
    await this.sql`
      INSERT INTO yhub_updates_v1 (org,docid,branch,gc,r,update,sv,contentmap)
      VALUES (${org},${docid},${branch},${gc},DEFAULT,${encodedUpdate},${Y.encodeStateVector(ydoc)},${Y.encodeContentMap(yContentMap || Y.mergeContentMaps([]))})
    `
  }

  /**
   * @param {string} org
   * @param {string} docid
   * @param {string} branch
   * @return {Promise<Y.ContentMap>}
   */
  async retrieveContentMap (org, docid, branch) {
    const rows = await this.sql`SELECT contentmap from yhub_updates_v1 WHERE org = ${org} AND docid = ${docid} AND branch = ${branch}`
    return Y.mergeContentMaps(rows.map(row => Y.decodeContentMap(row.contentmap)))
  }

  /**
   * @template {boolean} [IncludeContentMap=false]
   * @param {string} org
   * @param {string} docid
   * @param {Object} opts
   * @param {boolean} [opts.gc]
   * @param {string} [opts.branch]
   * @param {IncludeContentMap} [opts.yContentMap]
   * @return {Promise<{ doc: Uint8Array, references: { db: Array<number>, s3: Array<string> }, yContentMap: IncludeContentMap extends true ? Y.ContentMap : null } | null>}
   */
  async retrieveDoc (org, docid, { gc = true, branch = 'main', yContentMap } = {}) {
    /**
     * @type {Array<{ r: number, update: Buffer, contentmap: Buffer }>}
     */
    const rows = yContentMap
      ? await this.sql`SELECT update,r,contentmap from yhub_updates_v1 WHERE org = ${org} AND docid = ${docid} AND branch = ${branch} AND gc = ${gc}`
      : await this.sql`SELECT update,r from yhub_updates_v1 WHERE org = ${org} AND docid = ${docid} AND branch = ${branch} AND gc = ${gc}`
    if (rows.length === 0) {
      return null
    }
    const rowcmaps = yContentMap ? rows.map(row => Y.decodeContentMap(row.contentmap)) : []
    const updatesParsed = rows.map(row => $yUpdate.expect(buffer.decodeAny(row.update)))
    const docV1Updates = await promise.all(updatesParsed.map(updateParsed => readYUpdateToV1(this.s3client, this.s3bucket, updateParsed)))
    const s3References = updatesParsed.map(updateParsed => updateParsed.path).filter(x => x != null)
    const doc = Y.mergeUpdates(docV1Updates)
    const ycm = yContentMap ? Y.mergeContentMaps(rowcmaps) : null
    const references = rows.map(row => row.r)
    return { doc, references: { db: references, s3: s3References }, yContentMap: /** @type {any} */ (ycm) }
  }

  /**
   * @param {string} org
   * @param {string} docid
   * @param {Object} opts
   * @param {boolean} [opts.gc]
   * @param {string} [opts.branch]
   * @return {Promise<Uint8Array|null>}
   */
  async retrieveStateVector (org, docid, { gc = true, branch = 'main' } = {}) {
    const rows = await this.sql`SELECT sv from yhub_updates_v1 WHERE org = ${org} AND docid = ${docid} AND branch = ${branch} AND gc = ${gc} LIMIT 1`
    if (rows.length > 1) {
      // expect that result is limited
      error.unexpectedCase()
    }
    return rows.length === 0 ? null : rows[0].sv
  }

  /**
   * @param {string} org
   * @param {string} docid
   * @param {{ db: Array<number>, s3: Array<string> }} storeReferences
   * @param {Object} opts
   * @param {boolean} [opts.gc]
   * @param {string} [opts.branch]
   * @return {Promise<void>}
   */
  async deleteReferences (org, docid, storeReferences, { gc = true, branch = 'main' } = {}) {
    await promise.all([
      this.sql`DELETE FROM yhub_updates_v1 WHERE org = ${org} AND docid = ${docid} AND branch = ${branch} AND gc = ${gc} AND r = ANY(${storeReferences.db})`,
      this.s3client.removeObjects(this.s3bucket, storeReferences.s3)
    ])
  }

  async destroy () {
    await this.sql.end({ timeout: 5 }) // existing queries have five seconds to finish
  }
}
