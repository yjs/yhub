#!/usr/bin/env node

import postgres from 'postgres'
import * as env from 'lib0/environment'

/**
 * Initialize the database and tables for y/hub
 * @param {string} postgresUrl - postgres://username:password@host:port/database
 */
async function init (postgresUrl) {
  console.log(`[init-db] Initializing database from URL: ${postgresUrl}`)
  // Extract database from URL path
  const database = new URL(postgresUrl).pathname.slice(1)
  if (database !== '') {
    // Step 1: Create database if URL includes one
    console.log(`[init-db] Ensuring database '${database}' exists...`)
    // Connect to default 'postgres' database for admin operations
    const adminDbUrl = postgresUrl.replace(/\/[^/]*$/, '/postgres')
    const adminSql = postgres(adminDbUrl, { max: 1 })
    try {
      const dbExists = await adminSql`
        SELECT EXISTS (
          SELECT FROM pg_database WHERE datname = ${database}
        );
      `
      if (!dbExists || dbExists.length === 0 || !dbExists[0].exists) {
        console.log(`[init-db] Creating database '${database}'...`)
        await adminSql.unsafe(`CREATE DATABASE "${database}"`)
        console.log(`[init-db] ✓ Database '${database}' created`)
      } else {
        console.log(`[init-db] ✓ Database '${database}' already exists`)
      }
    } finally {
      await adminSql.end({ timeout: 5 })
    }
  }

  // Step 2: Create tables
  console.log('[init-db] Creating tables...')
  const sql = postgres(postgresUrl, { max: 1 })
  try {
    // Create updates table
    const updatesTableExists = await sql`
      SELECT EXISTS (
        SELECT FROM pg_tables
        WHERE tablename = 'yhub_updates_v1'
      );
    `
    if (!updatesTableExists || updatesTableExists.length === 0 || !updatesTableExists[0].exists) {
      console.log('[init-db] Creating yhub_updates_v1 table...')
      // @todo move contentmap and sv to another table!
      await sql`
        CREATE TABLE IF NOT EXISTS yhub_updates_v1 (
            org             text,
            docid           text,
            branch          text DEFAULT 'main',
            gc              boolean DEFAULT true,
            r               SERIAL,
            update          bytea,
            sv              bytea,
            contentmap      bytea,
            PRIMARY KEY     (org,docid,branch,gc,r)
        );
      `
      console.log('[init-db] ✓ yhub_updates_v1 table created')
    } else {
      console.log('[init-db] ✓ yhub_updates_v1 table already exists')
    }

    // Create attributions table
    const attributionsTableExists = await sql`
      SELECT EXISTS (
        SELECT FROM pg_tables
        WHERE tablename = 'yhub_attributions_v1'
      );
    `
    if (!attributionsTableExists || attributionsTableExists.length === 0 || !attributionsTableExists[0].exists) {
      console.log('[init-db] Creating yhub_attributions_v1 table...')
      await sql`
        CREATE TABLE IF NOT EXISTS yhub_attributions_v1 (
            org         text,
            docid       text,
            branch      text DEFAULT 'main',
            contentmap  bytea,
            PRIMARY KEY (org,docid,branch)
        );
      `
      console.log('[init-db] ✓ yhub_attributions_v1 table created')
    } else {
      console.log('[init-db] ✓ yhub_attributions_v1 table already exists')
    }
  } finally {
    await sql.end({ timeout: 5 })
  }

  console.log(`[init-db] ✓ Initialization done: ${postgresUrl}`)
}

console.log('[init-db] Initializing databases based on environment variables POSTGRES & POSTGRES_TESTING')

const postgresUrl = env.getConf('postgres')
const postgresTestingUrl = env.getConf('postgres-testing')
postgresUrl && await init(postgresUrl)
postgresTestingUrl && await init(postgresTestingUrl)

console.log('[init-db] All databases initialized successfully')
