#!/usr/bin/env node

/**
 * Allocates a block of host ports for this worktree, so that several worktrees of this repo
 * can run their dev infrastructure (valkey / postgres / minio) and their test suites side by
 * side without ever touching each other's data.
 *
 * The block is derived from a hash of the worktree path and claimed in
 * `~/.cache/yhub/dev-ports/{base}`. The allocation is written to the managed section at the
 * bottom of `.env` - everything above that section is yours and is preserved.
 *
 *   node scripts/dev-env.js            # ensure an allocation, write .env
 *   node scripts/dev-env.js --up       # ... + start the dev infrastructure + init databases
 *   node scripts/dev-env.js --down     # stop the dev infrastructure (keeps volumes)
 *   node scripts/dev-env.js --release  # stop, drop volumes, give the port block back
 *   node scripts/dev-env.js --force    # re-derive and rewrite even if .env is still valid
 */

import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as env from 'lib0/environment'
import * as fnv1a from 'lib0/hash/fnv1a'
import * as number from 'lib0/number'
import * as promise from 'lib0/promise'

const root = path.resolve(import.meta.dirname, '..')
const blockSize = 16
// the range starts above the well-known default port (4400) and ends far below the ephemeral
// port range (32768+), so that outgoing connections never squat an allocated block
const rangeStart = number.parseInt(env.getConf('dev-port-start') || '4416')
const numBlocks = number.parseInt(env.getConf('dev-port-blocks') || '32')
const claimDir = path.join(os.homedir(), '.cache/yhub/dev-ports')
const marker = '# --- managed by scripts/dev-env.js - everything below is overwritten ---'

/**
 * @param {number} port
 * @return {Promise<boolean>}
 */
const isFree = port => promise.create(resolve => {
  const server = net.createServer()
  server.once('error', () => resolve(false))
  // 0.0.0.0 because that is where the container runtime publishes ports
  server.listen({ port, host: '0.0.0.0', exclusive: true }, () => server.close(() => resolve(true)))
})

/**
 * @param {number} base
 */
const claimFile = base => path.join(claimDir, `${base}`)

/**
 * Claim the block starting at `base`. A block that is already ours is accepted without
 * probing - its ports are busy precisely because our own containers are running.
 *
 * @param {number} base
 * @return {Promise<boolean>}
 */
const tryClaim = async base => {
  const f = claimFile(base)
  const owner = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : null
  if (owner === root) return true
  if (owner != null && fs.existsSync(owner)) return false
  for (let i = 0; i < blockSize; i++) {
    if (!(await isFree(base + i))) return false
  }
  // the worktree that owned this block is gone
  owner != null && fs.rmSync(f, { force: true })
  try {
    fs.writeFileSync(f, root, { flag: 'wx' })
  } catch (err) {
    return false // another worktree won the race
  }
  return true
}

/**
 * @return {Promise<number>}
 */
const allocate = async () => {
  const start = fnv1a.digestString(root) % numBlocks
  for (let i = 0; i < numBlocks; i++) {
    const base = rangeStart + ((start + i) % numBlocks) * blockSize
    if (await tryClaim(base)) return base
  }
  throw new Error(`no free port block in ${rangeStart}-${rangeStart + numBlocks * blockSize - 1}. Widen the range with DEV_PORT_BLOCKS.`)
}

/**
 * @param {number} base
 */
const release = base => {
  const f = claimFile(base)
  fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim() === root && fs.rmSync(f)
}

/**
 * Rewrite the managed section of `.env`, preserving everything the user put above it. Managed
 * keys are also stripped from the user section, so a stale hand-written `POSTGRES` can never
 * shadow the derived one.
 *
 * @param {Array<[string,string|number]>} vars
 */
const writeEnv = vars => {
  const file = path.join(root, '.env')
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fs.readFileSync(path.join(root, '.env.template'), 'utf8')
  const managedKeys = new Set(vars.map(([k]) => k))
  const body = prev.split(marker)[0].split('\n').filter(line => !managedKeys.has(line.split('=')[0].trim())).join('\n').trimEnd()
  fs.writeFileSync(file, `${body}\n\n${marker}\n${vars.map(([k, v]) => `${k}=${v}`).join('\n')}\n`)
}

fs.mkdirSync(claimDir, { recursive: true })

const envFile = path.join(root, '.env')
const prevMatch = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').match(/^YHUB_PORT_BASE=(\d+)$/m) : null
const prevBase = prevMatch ? number.parseInt(prevMatch[1]) : null
// .env is never trusted on its own - the claim registry decides whether we may keep the block
const base = (!env.hasParam('--force') && prevBase != null && await tryClaim(prevBase)) ? prevBase : await allocate()
prevBase != null && prevBase !== base && release(prevBase)

const project = `yhub-${path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${base}`
const postgresUrl = `postgres://yhub:yhub@localhost:${base + 1}/yhub`

writeEnv([
  ['YHUB_PORT_BASE', base],
  ['COMPOSE_PROJECT_NAME', project],
  // discrete host ports - consumed by compose.yaml via ${VAR}
  ['POSTGRES_PORT', base + 1],
  ['REDIS_PORT', base + 2],
  ['S3_PORT', base + 3],
  ['S3_CONSOLE_PORT', base + 4],
  ['DOCKER_PORT', base + 5],
  // yhub configuration
  ['PORT', base],
  ['TEST_PORT', base + 8],
  ['REDIS', `redis://localhost:${base + 2}`],
  ['POSTGRES', postgresUrl],
  ['POSTGRES_TESTING', `${postgresUrl}-testing`],
  ['S3_ENDPOINT', 'localhost'],
  ['S3_SSL', 'false']
])

/**
 * @param {Array<string>} args
 */
const compose = args =>
  execFileSync('docker', ['compose', '--env-file', '.env', '-p', project, ...args], { cwd: root, stdio: 'inherit' })

/**
 * @param {number} port
 * @return {Promise<boolean>}
 */
const canConnect = port => promise.create(resolve => {
  const socket = net.connect({ port, host: '127.0.0.1' })
  const done = (/** @type {boolean} */ ok) => { socket.destroy(); resolve(ok) }
  socket.setTimeout(1000)
  socket.on('connect', () => done(true))
  socket.on('error', () => done(false))
  socket.on('timeout', () => done(false))
})

if (env.hasParam('--up')) {
  compose(['up', '-d'])
  await promise.untilAsync(async () => (await promise.all([base + 1, base + 2, base + 3].map(canConnect))).every(ok => ok), 60000, 250)
  // postgres and minio accept connections before they serve requests. init-db is idempotent,
  // so retrying it is both the readiness check and the initialization.
  await promise.untilAsync(async () => {
    try {
      execFileSync(process.execPath, ['--env-file', '.env', 'bin/init-db.js'], { cwd: root, stdio: 'inherit' })
      return true
    } catch (err) {
      return false
    }
  }, 60000, 1000)
}

if (env.hasParam('--down')) compose(['down'])

if (env.hasParam('--release')) {
  compose(['down', '-v'])
  release(base)
}

console.log(`${project}: ports ${base}-${base + blockSize - 1}`)
