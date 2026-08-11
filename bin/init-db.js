#!/usr/bin/env node

import postgres from 'postgres'
import * as env from 'lib0/environment'
import { Client as S3Client } from 'minio'
import { createClient as createRedisClient } from 'redis'
import { logger } from '../src/logger.js'

const log = logger.child({ module: 'init-db' })

/**
 * Create the tables y/hub needs, unless they already exist.
 *
 * This script is the only thing in y/hub that runs DDL. Servers and workers never do, so they
 * need no permission to, and a schema change happens when an operator runs this rather than
 * implicitly during a rolling deploy. Re-run it when upgrading to a release that adds a table -
 * every such release says so in the changelog.
 *
 * @param {import('postgres').Sql} sql
 */
const initTables = async sql => {
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
        gcDoc_is_reference      boolean NOT NULL DEFAULT true,
        nongcDoc_is_reference   boolean NOT NULL DEFAULT true,
        contentmap_is_reference boolean NOT NULL DEFAULT true,
        contentids_is_reference boolean NOT NULL DEFAULT true,
        PRIMARY KEY     (org,docid,branch,t)
    )
  `
  // `CREATE TABLE IF NOT EXISTS` above leaves an existing table untouched, so columns added in a
  // later release need their own ALTER. `DEFAULT true` is the whole migration: a pre-existing row
  // reads as "this may be a reference", which makes readers fetch the column and check - exactly
  // what they did before the markers existed. No backfill, and no state that means "unknown".
  // Postgres stores the default in the catalog, so this does not rewrite the table.
  await sql`ALTER TABLE yhub_ydoc_v1 ADD COLUMN IF NOT EXISTS gcDoc_is_reference boolean NOT NULL DEFAULT true`
  await sql`ALTER TABLE yhub_ydoc_v1 ADD COLUMN IF NOT EXISTS nongcDoc_is_reference boolean NOT NULL DEFAULT true`
  await sql`ALTER TABLE yhub_ydoc_v1 ADD COLUMN IF NOT EXISTS contentmap_is_reference boolean NOT NULL DEFAULT true`
  await sql`ALTER TABLE yhub_ydoc_v1 ADD COLUMN IF NOT EXISTS contentids_is_reference boolean NOT NULL DEFAULT true`
  await sql`
    CREATE TABLE IF NOT EXISTS yhub_ydoc_tombstones_v1 (
        org             text,
        docid           text,
        branch          text,
        deleted_at      INT8 NOT NULL,
        hard            boolean NOT NULL,
        purged_at       INT8,
        by              text,
        PRIMARY KEY     (org,docid,branch)
    )
  `
  // partial: the only non-key query shape is "what still needs purging", so the index stays
  // proportional to pending deletions rather than to every deletion ever
  await sql`
    CREATE INDEX IF NOT EXISTS yhub_ydoc_tombstones_v1_pending
    ON yhub_ydoc_tombstones_v1 (deleted_at) WHERE purged_at IS NULL
  `
}

/**
 * Initialize the database and tables for y/hub
 * @param {string} postgresUrl - postgres://username:password@host:port/database
 */
async function init (postgresUrl) {
  log.info({ postgresUrl }, 'initializing database')
  // Extract database from URL path
  const database = new URL(postgresUrl).pathname.slice(1)
  if (database !== '') {
    // Step 1: Create database if URL includes one
    log.info({ database, postgresUrl }, 'ensuring database exists')
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
        log.info({ database }, 'creating database')
        await adminSql.unsafe(`CREATE DATABASE "${database}"`)
        log.info({ database }, 'database created')
      } else {
        log.info({ database }, 'database already exists')
      }
    } finally {
      await adminSql.end({ timeout: 5 })
    }
  }

  // Step 2: Create tables
  log.info('creating tables')
  const sql = postgres(postgresUrl, { max: 1 })
  try {
    await initTables(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
  log.info({ postgresUrl }, 'initialization done')
}

/**
 * Initialize S3 bucket if it doesn't exist
 * @param {S3Client} s3client
 * @param {string} bucket
 */
async function initS3Bucket (s3client, bucket) {
  log.info({ bucket }, 'checking if S3 bucket exists')
  const exists = await s3client.bucketExists(bucket)
  if (!exists) {
    log.info({ bucket }, 'creating S3 bucket')
    await s3client.makeBucket(bucket)
    log.info({ bucket }, 'S3 bucket created')
  } else {
    log.info({ bucket }, 'S3 bucket already exists')
  }
}

log.info('initializing databases based on environment variables POSTGRES & POSTGRES_TESTING')

const postgresUrl = env.getConf('postgres')
const postgresTestingUrl = env.getConf('postgres-testing')
postgresUrl && await init(postgresUrl)
postgresTestingUrl && await init(postgresTestingUrl)

// Initialize S3 buckets
const s3Bucket = env.getConf('S3_YHUB_BUCKET')
const s3TestBucket = env.getConf('S3_YHUB_TEST_BUCKET')

if (s3Bucket) {
  log.info('initializing S3 buckets')
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
const prefix = env.getConf('redis-prefix') || 'yhub'
const redisWorkerStreamName = prefix + ':worker'
if (redisUrl) {
  const redis = createRedisClient({ url: redisUrl })
  await redis.connect()
  try {
    await redis.xGroupCreate(redisWorkerStreamName, redisWorkerStreamName, '0', { MKSTREAM: true })
    log.info({ redisWorkerStreamName }, 'successfully created redis worker stream and group')
  } catch (err) {
    // the group already exists - anything else must fail the initialization
    if (!/BUSYGROUP/.test(/** @type {Error} */ (err).message)) throw err
    log.info({ redisWorkerStreamName }, 'redis worker stream and group already exist')
  }
}

log.info('all databases initialized successfully')

process.exit(0)
