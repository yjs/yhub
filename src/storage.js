import * as Y from 'yjs'
import postgres from 'postgres'
import * as error from 'lib0/error'

/**
 * @param {string} postgresUrl - postgres://username:password@host:port/database
 */
export const createPostgresStorage = async (postgresUrl) => {
  const postgresConf = {}
  // If a specific database is requested, ensure it exists
  const sql = postgres(postgresUrl, postgresConf)

  const docsTableExists = await sql`
    SELECT EXISTS (
      SELECT FROM
          pg_tables
      WHERE
          tablename  = 'yredis_docs_v2'
    );
  `
  // we perform a check beforehand to avoid a pesky log message if the table already exists
  if (!docsTableExists || docsTableExists.length === 0 || !docsTableExists[0].exists) {
    await sql`
      CREATE TABLE IF NOT EXISTS yredis_docs_v2 (
          room        text,
          doc         text,
          branch      text DEFAULT 'main',
          gc          boolean DEFAULT true,
          r           SERIAL,
          update      bytea,
          sv          bytea,
          PRIMARY KEY (room,doc,branch,gc,r)
      );
    `
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
   * @param {string} room
   * @param {string} docname
   * @param {Y.Doc} ydoc
   * @param {Object} opts
   * @param {boolean} [opts.gc]
   * @param {string} [opts.branch]
   * @returns {Promise<void>}
   */
  async persistDoc (room, docname, ydoc, { gc = true, branch = 'main' } = {}) {
    await this.sql`
      INSERT INTO yredis_docs_v2 (room,doc,branch,gc,r,update,sv)
      VALUES (${room},${docname},${branch},${gc},DEFAULT,${Y.encodeStateAsUpdateV2(ydoc)},${Y.encodeStateVector(ydoc)})
    `
  }

  /**
   * @param {string} room
   * @param {string} docname
   * @param {Object} opts
   * @param {boolean} [opts.gc]
   * @param {string} [opts.branch]
   * @return {Promise<{ doc: Uint8Array, references: Array<number> } | null>}
   */
  async retrieveDoc (room, docname, { gc = true, branch = 'main' } = {}) {
    /**
     * @type {Array<{ room: string, doc: string, branch: string, gc: boolean, r: number, update: Buffer }>}
     */
    const rows = await this.sql`SELECT update,r from yredis_docs_v2 WHERE room = ${room} AND doc = ${docname} AND branch = ${branch} AND gc = ${gc}`
    if (rows.length === 0) {
      return null
    }
    const doc = Y.mergeUpdatesV2(rows.map(row => row.update))
    const references = rows.map(row => row.r)
    return { doc, references }
  }

  /**
   * @param {string} room
   * @param {string} docname
   * @param {Object} opts
   * @param {boolean} [opts.gc]
   * @param {string} [opts.branch]
   * @return {Promise<Uint8Array|null>}
   */
  async retrieveStateVector (room, docname, { gc = true, branch = 'main' } = {}) {
    const rows = await this.sql`SELECT sv from yredis_docs_v2 WHERE room = ${room} AND doc = ${docname} AND branch = ${branch} AND gc = ${gc} LIMIT 1`
    if (rows.length > 1) {
      // expect that result is limited
      error.unexpectedCase()
    }
    return rows.length === 0 ? null : rows[0].sv
  }

  /**
   * @param {string} room
   * @param {string} docname
   * @param {Array<any>} storeReferences
   * @param {Object} opts
   * @param {boolean} [opts.gc]
   * @param {string} [opts.branch]
   * @return {Promise<void>}
   */
  async deleteReferences (room, docname, storeReferences, { gc = true, branch = 'main' } = {}) {
    await this.sql`DELETE FROM yredis_docs_v2 WHERE room = ${room} AND doc = ${docname} AND branch = ${branch} AND gc = ${gc} AND r in (${storeReferences})`
  }

  async destroy () {
    await this.sql.end({ timeout: 5 }) // existing queries have five seconds to finish
  }
}
