/**
 * @param {import('../api.js').Api} api
 */
export const attributionPlugin = async (api) => {
  const sql = api.sql
  const docsTableExists = await sql`
    SELECT EXISTS (
      SELECT FROM
          pg_tables
      WHERE
          tablename  = 'yhub_attributions_v1'
    );
  `
  // perform a check beforehand to avoid a pesky log message if the table already exists
  if (!docsTableExists || docsTableExists.length === 0 || !docsTableExists[0].exists) {
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
  return new AttributionPlugin(sql)
}

export class AttributionPlugin {
  /**
   * @param {import('postgres').Sql} sql
   */
  constructor (sql) {
    this.sql = sql
  }

  /**
   * @return {'attributions'}
   */
  get key () { return 'attributions' }
}
