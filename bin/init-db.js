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
  console.log(`[init-db] ✓ Initialization done: ${postgresUrl}`)
}

console.log('[init-db] Initializing databases based on environment variables POSTGRES & POSTGRES_TESTING')

const postgresUrl = env.getConf('postgres')
const postgresTestingUrl = env.getConf('postgres-testing')
postgresUrl && await init(postgresUrl)
postgresTestingUrl && await init(postgresTestingUrl)

console.log('[init-db] All databases initialized successfully')
