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

  { // INIT UPDATES TABLE
    const docsTableExists = await sql`
      SELECT EXISTS (
        SELECT FROM
            pg_tables
        WHERE
            tablename  = 'yhub_updates_v1'
      );
    `
    // we perform a check beforehand to avoid a pesky log message if the table already exists
    if (!docsTableExists || docsTableExists.length === 0 || !docsTableExists[0].exists) {
      await sql`
        CREATE TABLE IF NOT EXISTS yhub_updates_v1 (
            org         text,
            docid       text,
            branch      text DEFAULT 'main',
            gc          boolean DEFAULT true,
            r           SERIAL,
            update      bytea,
            sv          bytea,
            PRIMARY KEY (org,docid,branch,gc,r)
        );
      `
    }
  }

  { // INIT ATTRIBUTIONS TABLE
    const attributionsTableExists = await sql`
      SELECT EXISTS (
        SELECT FROM
            pg_tables
        WHERE
            tablename  = 'yhub_attributions_v1'
      );
    `
    // perform a check beforehand to avoid a pesky log message if the table already exists
    if (!attributionsTableExists || attributionsTableExists.length === 0 || !attributionsTableExists[0].exists) {
      await sql`
        CREATE TABLE IF NOT EXISTS yhub_attributions_v1 (
            org         text,
            docid       text,
            branch      text DEFAULT 'main',
            contentmap  bytea,
            PRIMARY KEY (org,docid,branch)
        );
      `
    }
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
   * @param {Object} opts
   * @param {boolean} [opts.gc]
   * @param {string} [opts.branch]
   * @returns {Promise<void>}
   */
  async persistDoc (org, docid, ydoc, { gc = true, branch = 'main' } = {}) {
    await this.sql`
      INSERT INTO yhub_updates_v1 (org,docid,branch,gc,r,update,sv)
      VALUES (${org},${docid},${branch},${gc},DEFAULT,${Y.encodeStateAsUpdateV2(ydoc)},${Y.encodeStateVector(ydoc)})
    `
  }

  /**
   * @param {string} org
   * @param {string} docid
   * @param {Object} opts
   * @param {boolean} [opts.gc]
   * @param {string} [opts.branch]
   * @return {Promise<{ doc: Uint8Array, references: Array<number> } | null>}
   */
  async retrieveDoc (org, docid, { gc = true, branch = 'main' } = {}) {
    /**
     * @type {Array<{ r: number, update: Buffer }>}
     */
    const rows = await this.sql`SELECT update,r from yhub_updates_v1 WHERE org = ${org} AND docid = ${docid} AND branch = ${branch} AND gc = ${gc}`
    if (rows.length === 0) {
      return null
    }
    const doc = Y.mergeUpdatesV2(/** @type {Uint8Array<ArrayBuffer>[]} */ (rows.map(row => row.update)))
    const references = rows.map(row => row.r)
    return { doc, references }
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
