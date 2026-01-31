#!/usr/bin/env node

import postgres from 'postgres'
import * as env from 'lib0/environment'
import { Client as S3Client } from 'minio'
import { createClient as createRedisClient } from 'redis'

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
    console.log('[init-db] postgres url', postgresUrl)
    // Connect to default 'postgres' database for admin operations
    // Preserve query parameters (like ssl=require) when switching database
    const url = new URL(postgresUrl)
    url.pathname = '/postgres'
    const adminDbUrl = url.toString()
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
        WHERE tablename = 'yhub_ydoc_v1'
      );
    `
    if (!updatesTableExists || updatesTableExists.length === 0 || !updatesTableExists[0].exists) {
      console.log('[init-db] Creating yhub_ydoc_v1 table...')
      // @todo move contentmap and sv to another table!
      await sql`
        CREATE TABLE IF NOT EXISTS yhub_ydoc_v1 (
            org             text,
            docid           text,
            branch          text,
            t               text,
            created         INT8,
            gcDoc           bytea,
            nongcDoc        bytea,
            contentmap      bytea,
            contentids      bytea,
            PRIMARY KEY     (org,docid,branch,t)
        );
      `
      console.log('[init-db] ✓ yhub_ydoc_v1 table created')
    } else {
      console.log('[init-db] ✓ yhub_ydoc_v1 table already exists')
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
  console.log(`[init-db] ✓ Initialization done: ${postgresUrl}`)
}

/**
 * Initialize S3 bucket if it doesn't exist
 * @param {S3Client} s3client
 * @param {string} bucket
 */
async function initS3Bucket (s3client, bucket) {
  console.log(`[init-db] Checking if S3 bucket '${bucket}' exists...`)
  const exists = await s3client.bucketExists(bucket)
  if (!exists) {
    console.log(`[init-db] Creating S3 bucket '${bucket}'...`)
    await s3client.makeBucket(bucket)
    console.log(`[init-db] ✓ S3 bucket '${bucket}' created`)
  } else {
    console.log(`[init-db] ✓ S3 bucket '${bucket}' already exists`)
  }
}

console.log('[init-db] Initializing databases based on environment variables POSTGRES & POSTGRES_TESTING')

const postgresUrl = env.getConf('postgres')
const postgresTestingUrl = env.getConf('postgres-testing')
postgresUrl && await init(postgresUrl)
postgresTestingUrl && await init(postgresTestingUrl)

// Initialize S3 buckets
const s3Bucket = env.getConf('S3_YHUB_BUCKET')
const s3TestBucket = env.getConf('S3_YHUB_TEST_BUCKET')

if (s3Bucket) {
  console.log('[init-db] Initializing S3 buckets...')
  const s3client = new S3Client({
    endPoint: env.ensureConf('S3_ENDPOINT'),
    port: parseInt(env.ensureConf('S3_PORT'), 10),
    useSSL: env.ensureConf('S3_SSL') === 'true',
    accessKey: env.ensureConf('S3_ACCESS_KEY'),
    secretKey: env.ensureConf('S3_SECRET_KEY')
  })
  await initS3Bucket(s3client, s3Bucket)
  if (s3TestBucket) {
    await initS3Bucket(s3client, s3TestBucket)
  }
}

const redisUrl = env.getConf('redis') || null
const prefix = env.getConf('redis-prefix')
const redisWorkerGroupName = prefix + ':worker'
const redisWorkerStreamName = prefix + ':worker'
if (redisUrl) {
  const redis = createRedisClient({ url: redisUrl })
  redis.connect()
  try {
    await redis.xGroupCreate(redisWorkerStreamName, redisWorkerGroupName, '0', { MKSTREAM: true })
    console.log('[init-db] successfully created redis worker and group')
  } catch (err) {
    console.error('[init-db] redis - failde to init worker stream: ', { redisWorkerStreamName, redisWorkerGroupName })
  }
}

console.log('[init-db] All databases initialized successfully')

process.exit(0)
