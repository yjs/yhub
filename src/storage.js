import * as Y from '@y/y'
import postgres from 'postgres'
import * as error from 'lib0/error'

/**
 * @param {string} postgresUrl - postgres://username:password@host:port/database
 */
export const createPostgresStorage = async (postgresUrl) => {
  const postgresConf = {}
  // If a specific database is requested, ensure it exists
  const sql = postgres(postgresUrl, postgresConf)

  try {
    await sql`SELECT 1 as connected`
  } catch (err) {
    throw new Error(`Can't connect to postgres. url: ${postgresUrl}.\n${err}`)
  }

  return new Storage(sql)
}

/**
 * A Storage implementation that persists documents in PostgreSQL.
 *
 * You probably want to adapt this to your own needs.
 */
export class Storage {
  /**
   * @param {postgres.Sql} sql
   */
  constructor (sql) {
    this.sql = sql
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
    await this.sql`
      INSERT INTO yhub_updates_v1 (org,docid,branch,gc,r,update,sv,contentmap)
      VALUES (${org},${docid},${branch},${gc},DEFAULT,${Y.encodeStateAsUpdateV2(ydoc)},${Y.encodeStateVector(ydoc)},${Y.encodeContentMap(yContentMap || Y.mergeContentMaps([]))})
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
   * @return {Promise<{ doc: Uint8Array, references: Array<number>, yContentMap: IncludeContentMap extends true ? Y.ContentMap : null } | null>}
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
    const doc = Y.mergeUpdatesV2(/** @type {Uint8Array<ArrayBuffer>[]} */ (rows.map(row => row.update)))
    const ycm = yContentMap ? Y.mergeContentMaps(rowcmaps) : null
    const references = rows.map(row => row.r)
    return { doc, references, yContentMap: /** @type {any} */ (ycm) }
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
   * @param {Array<any>} storeReferences
   * @param {Object} opts
   * @param {boolean} [opts.gc]
   * @param {string} [opts.branch]
   * @return {Promise<void>}
   */
  async deleteReferences (org, docid, storeReferences, { gc = true, branch = 'main' } = {}) {
    await this.sql`DELETE FROM yhub_updates_v1 WHERE org = ${org} AND docid = ${docid} AND branch = ${branch} AND gc = ${gc} AND r = ANY(${storeReferences})`
  }

  async destroy () {
    await this.sql.end({ timeout: 5 }) // existing queries have five seconds to finish
  }
}
