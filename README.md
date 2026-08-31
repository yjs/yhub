# y/hub :tophat:
> y-websocket compatible backend using Redis for scalability. **This is beta
> software!**

y/hub is an alternative backend for y-websocket. It only requires a redis
instance and a storage provider (S3 or Postgres-compatible).

* **Memory efficient:** The server doesn't maintain a Y.Doc in-memory. It
streams updates through redis. The Yjs document is only loaded to memory for the
initial sync.
* **Scalable:** You can start as many y/hub instances as you want to handle
a fluctuating number of clients. No coordination is needed.
- **Auth:** y/hub works together with your existing infrastructure to
authenticate clients and check whether a client has read-only / read-write
access to a document.
- **Database agnostic:** You can persist documents in S3-compatible backends, in
Postgres, or implement your own storage provider.

### Licensing

y/hub is dual-licensed (either [AGPL](./LICENSE) or proprietary).

Please contact me to buy a license if you intend to use y/hub in your
commercial product: <kevin.jahns at pm.me>

Otherwise, you may use this software under the terms of the AGPL, which requires
you to publish your source code under the terms of the AGPL too.

## Architecture

y/hub is designed as a distributed system with the following components:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Clients   │────▶│   Server    │────▶│    Redis    │
│ (y-websocket)│◀────│  (WebSocket)│◀────│  (pub/sub)  │
└─────────────┘     └─────────────┘     └─────────────┘
                           │                   │
                           │                   ▼
                           │            ┌─────────────┐
                           │            │   Worker    │
                           │            │ (background)│
                           │            └─────────────┘
                           │                   │
                           ▼                   ▼
                    ┌─────────────┐     ┌─────────────┐
                    │  PostgreSQL │     │     S3      │
                    │  (metadata) │     │   (blobs)   │
                    └─────────────┘     └─────────────┘
```

### Components

Redis is used as a "cache" and a distribution channel for document updates.
Normal databases are not fast enough for handling real-time updates of
fast-changing applications (e.g. collaborative drawing applications that
generate hundreds of operations per second). Hence a redis-cache for temporary
storage makes sense to distribute documents as fast as possible to all peers.

A persistent storage (e.g. S3 or Postgres) is used to persist document updates
permanently. You can configure in which intervals you want to persist data from
redis to the persistent storage. You can even implement a custom persistent
storage technology.

The y/hub **server component** (`/bin/server.js`) is responsible for accepting
websocket-connections and distributing the updates via redis streams. Each
document is represented as a redis stream. The server component assembles updates
stored redis and in the persistent storage (e.g. S3 or Postgres) for the initial
sync. After the initial sync, the server doesn't keep any Yjs state in-memory.
You can start as many server components as you need. It makes sense to put the
server component behind a loadbalancer, which can potentially auto-scale the
server component based on CPU or network usage.

The separate y/hub **worker component** (`/bin/worker.js`) is responsible for
extracting data from the redis cache to a persistent database like S3 or
Postgres. Once the data is persisted, the worker component cleans up stale data
in redis. You can start as many worker components as you need. It is recommended
to run at least one worker, so that the data is eventually persisted. The worker
components coordinate which document needs to be persisted using a separate
worker-queue (see `y:worker` stream in redis).

Authorization runs in-process: you pass an auth plugin (an object with
`authenticate` and `authorize` callbacks, built with `createAuthPlugin`) to the
server configuration. `authenticate` establishes who is asking — e.g. by
verifying a JWT your app issued — and `authorize` answers what that user may do
with a specific document. See [GETTING-STARTED.md](./GETTING-STARTED.md) for
examples.

## How Documents Are Stored

y/hub uses a hybrid storage approach optimized for both real-time performance
and durability.

### Real-time Layer (Redis)

When a client sends an update:
1. The update is published to a Redis stream (`{prefix}:room:{org}:{docid}:{branch}`)
2. All connected clients receive the update immediately via pub/sub
3. A task is queued for the worker to persist the update

### Persistence Layer (PostgreSQL + S3)

The worker periodically:
1. Reads pending updates from Redis streams
2. Merges them with the existing document state
3. Stores the merged update blob in S3
4. Stores metadata (state vector, content map, S3 reference) in PostgreSQL
5. Cleans up old updates from both storage layers

### Database Schema

Tables are created by `npm run start:init` — see
[STORAGE-ARCHITECTURE.md](./STORAGE-ARCHITECTURE.md#schema-creation) for the full layout and when
to re-run it.

```sql
-- Document versions. One row per compaction; rows are additive and merged on retrieval.
CREATE TABLE yhub_ydoc_v1 (
    org         text,           -- Organization/namespace
    docid       text,           -- Document identifier
    branch      text,
    t           text,           -- Redis stream clock of this version
    created     INT8,           -- Unix ms, derived from `t`
    gcDoc       bytea,          -- Garbage-collected update (or an S3 reference)
    nongcDoc    bytea,          -- Full-history update (or an S3 reference)
    contentmap  bytea,          -- Attribution content map
    contentids  bytea,          -- Attributed content ids
    PRIMARY KEY (org, docid, branch, t)
);

-- One row per deleted document. See `yhub.deleteDoc`.
CREATE TABLE yhub_ydoc_tombstones_v1 (
    org         text,
    docid       text,
    branch      text,
    deleted_at  INT8    NOT NULL, -- Unix ms
    hard        boolean NOT NULL, -- content erased immediately and irreversibly
    purged_at   INT8,             -- Unix ms the content was erased; NULL while it still exists
    by          text,
    PRIMARY KEY (org, docid, branch)
);
```

### Update Encoding

Updates stored in PostgreSQL reference S3 objects:

```javascript
// Stored in PostgreSQL (update column)
{ type: 's3:update:v1', path: 'org/docid-randomhex' }

// Stored in S3 at the path above
{ type: 'update:v1', update: Uint8Array }
```

## Configuration

All features are configurable using environment variables. For local development,
run `npm run dev:env` - it creates a `.env` from `.env.template` and fills in the
connection details for a dev environment that is unique to your checkout (see
[Local Development](#local-development)).

### Required Settings

```bash
# Redis connection
REDIS=redis://localhost:6379
REDIS_PREFIX=yhub                 # Prefix for all Redis keys

# S3 storage (MinIO compatible)
S3_ENDPOINT=localhost
S3_PORT=9000                      # locally: allocated by `npm run dev:env`
S3_SSL=false
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_YHUB_BUCKET=yhub               # Bucket for document storage

# PostgreSQL connection
POSTGRES=postgres://user:pass@localhost:5432/yhub
```

### Optional Settings

```bash
# Server port
PORT=4400

# Origin(s) allowed to call the api from a browser. Comma-separated for an allowlist (wildcards
# like https://*.example.com included), '*' for every origin. While unset, cross-origin browser
# access is closed; same-origin pages and non-browser clients always work.
CORS_ORIGIN=https://app.example.com,https://admin.example.com

# Testing database and websocket port (for running tests)
POSTGRES_TESTING=postgres://user:pass@localhost:5432/yhub-testing
S3_YHUB_TEST_BUCKET=yhub-testing
TEST_PORT=4424

# Logging: trace | debug | info | warn | error | fatal | silent
LOG_LEVEL=info

# Expert settings
REDIS_MIN_MESSAGE_LIFETIME=60000  # Minimum message lifetime in Redis (ms)
REDIS_TASK_DEBOUNCE=10000         # Worker task debounce time (ms)
```

## Integration Guide

### 1. Set up infrastructure

```bash
npm run dev:up
```

This starts Valkey, PostgreSQL and MinIO in containers, creates the PostgreSQL
tables and the S3 buckets, and writes the connection details to `.env`. Ports are
allocated per checkout - see [Local Development](#local-development).

### 2. Generate token signing keys

```bash
npx 0ecdsa-generate-keypair --name auth
```

These keys are your application's JWT concern, not y/hub's: your app signs
tokens with the private key (step 4) and your auth plugin verifies them with the
public key (step 3). Store them wherever your app keeps its secrets — y/hub
itself does not read them.

### 3. Implement the auth plugin

Authorization runs in-process. Build an auth plugin with `createAuthPlugin` and
pass it as `server.auth` to `createYHub()`. `authenticate` establishes who is
asking — return anything identifying the user, or `null` for an anonymous
caller (throw a branded `apiError(401, ...)` to reject a credential).
`authorize` answers what that user — `null` when anonymous — may do in a given
scope: return a permission object, or `null` to deny. Denial is a value, never a
throw — a throw signals an infrastructure failure. Writing a document needs an
identity (attributions carry the userid); everything else works anonymously
when granted.

```javascript
import { createAuthPlugin, createAuthorize } from '@y/hub'
import * as jwt from 'lib0/crypto/jwt'
import * as ecdsa from 'lib0/crypto/ecdsa'

const authPublicKey = await ecdsa.importKeyJwk(JSON.parse(process.env.AUTH_PUBLIC_KEY))

// The classic read-write / read-only access levels expressed as permission objects.
const docPermissions = {
  rw: {
    type: 'permissions:document:v1',
    ydoc: 'cru-',         // positional crud mask, '-' denies: r = read/sync, u = write (c/d reserved, do nothing yet)
    awareness: '-ru-',    // r = receive presence, u = broadcast own (c/d reserved)
    history: { from: 0 }, // from-ray, unix ms; 0 grants the full history
    endpoint: { '*': 'crud' } // rest endpoints + the websocket route ('ws'), '*' = fallback
  },
  r: {
    type: 'permissions:document:v1',
    ydoc: '-r--',
    awareness: '-ru-',
    history: { from: 0 },
    endpoint: { '*': '-r--' }
  }
}

const auth = createAuthPlugin({
  async authenticate (req) {
    // Verify the JWT your app issued (step 4).
    const token = req.getQuery('yauth')
    const { payload } = await jwt.verifyJwt(authPublicKey, token)
    return { userid: payload.yuserid }
  },
  // One handler per scope - scopes without a handler deny, and the handler's return type is
  // forced to match its scope. docRef is the { org, docid, branch } triple.
  authorize: createAuthorize({
    document: async (docRef, user) => {
      // Check your database / business logic here.
      const access = await checkUserAccess(user.userid, docRef) // 'rw' | 'r' | null
      return access === null ? null : docPermissions[access]
    }
  })
})
```

Destructive rights (`delete`, `history.rollback`, `history.prune`) are granted
by name and deliberately absent from a plain read/write mapping. The schemas and
combinators live in `@y/hub/permissions`; see
[GETTING-STARTED.md](./GETTING-STARTED.md) for complete examples.

### 4. Implement token generation

Clients need a JWT token to connect. Create an endpoint that generates tokens:

```javascript
import * as jwt from 'lib0/crypto/jwt'
import * as ecdsa from 'lib0/crypto/ecdsa'
import * as time from 'lib0/time'

const authPrivateKey = await ecdsa.importKeyJwk(JSON.parse(process.env.AUTH_PRIVATE_KEY))

app.get('/auth/token', async (req, res) => {
  // Authenticate the user first (session, OAuth, etc.)
  const userId = req.user.id

  const token = await jwt.encodeJwt(authPrivateKey, {
    iss: 'your-app-name',
    exp: time.getUnixTime() + 60 * 60 * 1000,  // 1 hour expiry
    yuserid: userId
  })

  res.send(token)
})
```

### 5. Connect from the client

```javascript
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

// Get auth token from your backend
const authToken = await fetch('/auth/token').then(r => r.text())

const ydoc = new Y.Doc()
const provider = new WebsocketProvider(
  'ws://localhost:4400/api/ws/v1',
  'my-document',
  ydoc,
  {
    params: { yauth: authToken },
    // Or use WebSocket subprotocol:
    // protocols: [`yauth-${authToken}`]
  }
)

// Periodically refresh the auth token (it expires after 1 hour by default)
setInterval(async () => {
  provider.params.yauth = await fetch('/auth/token').then(r => r.text())
}, 30 * 60 * 1000)  // Every 30 minutes

// Use the document
const ytext = ydoc.getText('content')
ytext.insert(0, 'Hello, world!')
```

The provider reconnects automatically on any disconnect. Stop it when the server closes with a
permanent code (`4400`–`4499`, e.g. `4401` permission revoked) — see [API.md → Errors](API.md#errors).

### 6. Start the server

```bash
# Start both server and worker
npm start

# Or start them separately
npm run start:server
npm run start:worker
```

## Scaling

y/hub is designed for horizontal scaling:

1. **Multiple Server Instances**: Run multiple server instances behind a load
   balancer. Redis pub/sub ensures all instances receive updates.

2. **Multiple Workers**: Run multiple worker instances. Redis consumer groups
   hand each task to one worker at a time, and a worker renews the lease of the
   tasks it is running so that a long compaction is not picked up twice. A task
   whose worker dies is reclaimed after `redis.taskDebounce`, so a task may run
   more than once — compaction results are idempotent.

3. **Database Scaling**: PostgreSQL and S3 can be scaled independently based on
   your needs.

### Missing Features

I'm looking for sponsors that want to sponsor the following work:

- Helm chart
- More exhaustive logging and reporting of possible issues
- More exhaustive testing
- Better documentation & more documentation for specific use-cases
- Support for Bun and Deno
- Perform expensive tasks (computing sync messages) in separate threads

If you are interested in sponsoring some of this work, please send a mail to
<kevin.jahns at pm.me>.

## Experimental: native merge via yrs (y-crdt/yn)

> :warning: **Highly experimental.** Off by default. Do not enable in production.

y/hub can optionally use [y-crdt/yn](https://github.com/y-crdt/yn) — a thin
Node.js binding (via [neon](https://neon-rs.dev/)) over [yrs](https://github.com/y-crdt/y-crdt),
the Rust port of Yjs — to perform `mergeUpdates` natively instead of in
JavaScript. This is intended for benchmarking the merge hot path; everything
else (sync protocol, attribution metadata, delta/changeset computation,
awareness, snapshots, undo) continues to run on `@y/y`.

**Scope.** Only the three `Y.mergeUpdates` call sites are affected:

- the inline fast path on the main thread (`src/compute.js`)
- the worker-thread merge task (`src/compute-worker.js`)
- the WebSocket sync fan-out (`src/server.js`)

When the flag is off, behavior is unchanged — `mergeUpdates` resolves to
`Y.mergeUpdates` (see `src/y-utils.js`).

**Caveats.**

- `@y-crdt/yn` exposes a single function (`applyUpdates(gc, updates)`). v2
  update encoding is not supported.
- Protocol compatibility between yrs and `@y/y` 14's attribution-laden updates
  is **not verified**. Updates may round-trip incorrectly. Test against your
  workload before drawing any conclusions.

### Run with native merge enabled

After the standard setup (see the **Integration Guide** above), set
`USE_Y_NATIVE=1` in your environment (or pass `--use-y-native` on the CLI):

```bash
# one-off
USE_Y_NATIVE=1 node --env-file .env ./bin/yhub.js

# or in your .env (or .env.testing)
echo 'USE_Y_NATIVE=1' >> .env
npm run start:server
```

The flag is read via `lib0/environment.hasConf`, so both `USE_Y_NATIVE=…` and
`--use-y-native` work. Server and worker each evaluate the flag independently;
set it for both processes if you want native merges everywhere.

# Quick Start (standalone Docker)

The fastest way to try y/hub. A single container runs PostgreSQL, Valkey
(Redis), and y/hub together — no external services required.

```bash
docker run -p 4400:4400 ghcr.io/yjs/yhub/standalone:latest
```

Data is stored inside the container and lost when it stops. To persist data
across restarts, mount a volume:

```bash
docker run -p 4400:4400 -v yhub-data:/data ghcr.io/yjs/yhub/standalone:latest
```

Connect a Yjs client to `ws://localhost:4400/api/ws/v1/my-org/my-doc` and start
collaborating.

> **Note:** The standalone container uses open authentication (any client can
> read/write any document). It is intended for development and evaluation. For
> production, use the full setup below with a proper auth plugin.

# Local Development

```sh
git clone https://github.com/yjs/yhub.git
cd yhub
npm i
npm start
```

`npm start` provisions the dev environment and then runs a server and a worker in
one process. Provisioning is handled by `scripts/dev-env.js`, which

- allocates a block of 16 free host ports for this checkout (range `4416`-`4927`,
  claimed in `~/.cache/yhub/dev-ports/`, derived from a hash of the checkout path),
- writes them into the managed section at the bottom of `.env`, creating that file
  from `.env.template` if it does not exist yet,
- starts Valkey, PostgreSQL and MinIO in a compose project named after the checkout, and
- creates the databases, tables and S3 buckets.

Because every checkout gets its own ports, its own containers and its own volumes,
several git worktrees can run their servers and test suites simultaneously without
sharing any state. Everything you write *above* the managed marker in `.env` -
credentials, `REDIS_PREFIX`, `LOG_LEVEL` - is preserved when the ports are
regenerated.

```sh
npm run dev:up       # only provision (this is what npm start / npm test call)
npm run dev:down     # stop the containers, keep the data volumes
npm run dev:release  # stop, drop the volumes, release the port block
npm run dev:env -- --force  # re-derive the allocation
```

Note: if you want to use any of the docker commands, feel free to use podman (a
more modern alternative) instead.

The server and the worker can also be run as separate processes, in separate
terminals:

```sh
# run the server
npm run start:server
# run a single worker in a separate terminal
npm run start:worker
```

To run y/hub itself in containers as well, use the `app` compose profile:

```sh
docker compose --profile app up
```

## Plugins

### S3 Persistence (`S3PersistenceV1`)

Stores document blobs in any S3-compatible object store (AWS S3, MinIO, etc.).
Objects larger than 5 MB are uploaded using S3 multipart upload.

**Usage**

Pass an `S3PersistenceV1` instance in the `persistence` array when calling
`createYHub()`:

```javascript
import { createYHub } from '@y/hub'
import { S3PersistenceV1 } from '@y/hub/plugins/s3'

const yhub = await createYHub({
  redis:    { url: 'redis://localhost:6379', prefix: 'yhub' },
  postgres: 'postgres://user:pass@localhost:5432/yhub',
  persistence: [
    new S3PersistenceV1({
      bucket:    'yhub',
      endPoint:  'localhost',
      port:      9000,
      useSSL:    false,
      accessKey: 'minioadmin',
      secretKey: 'minioadmin',
      // enable: false,       // stop persisting new assets, keep serving existing ones (default: true)
      // branches: ['main'],  // offload only the listed branches (default: every branch)
      // deleteVersions: false,  // versioned buckets: only place delete markers (default: erase versions)
    })
  ],
  server: { /* ... */ },
})
```

The optional `branches` option restricts which branches are offloaded to S3: `true` (the
default) offloads every branch, an array offloads only the listed ones. Assets on branches
the plugin skips are stored inline in PostgreSQL instead.

`enable: false` loads the plugin without persisting: new assets store inline in PostgreSQL as if
no plugin were configured, while already-offloaded references keep resolving — and keep being
cleaned up as compaction supersedes them, so the bucket drains gradually. Useful to pause
offloading or migrate off S3 without losing access to existing documents.

On a bucket with versioning enabled, a plain delete only writes a delete marker — every stored
version would persist forever. `deleteVersions` controls this: `true` (the default) deletes the
object version recorded at store time, so compaction and hard deletes erase what they wrote;
`false` leaves the standard delete marker so deleted bytes can be restored or expired with bucket
lifecycle rules by the operator. Versions the plugin has no record of — objects written before
this feature, or duplicates left by a crashed or concurrent compaction — are not searched for and
deleted; expire them with lifecycle rules. Note that yhub drops its PostgreSQL rows on deletion
either way — `deleteVersions: false` preserves raw blobs for manual recovery (e.g. re-import via
`unsafePersistDoc`), not live documents.

The environment variables `S3_ENDPOINT`, `S3_PORT`, `S3_SSL`, `S3_ACCESS_KEY`,
`S3_SECRET_KEY`, and `S3_YHUB_BUCKET` are mapped to these fields by the default
configuration loader.

**Required IAM permissions**

| Permission | When required |
|---|---|
| `s3:CreateBucket` | On first start (bucket auto-creation) |
| `s3:ListBucket` | Always |
| `s3:GetObject` | Always |
| `s3:PutObject` | Always |
| `s3:DeleteObject` | Always |
| `s3:DeleteObjectVersion` | Versioned buckets (with `deleteVersions`, the default) |
| `s3:ListBucketMultipartUploads` | Objects > 5 MB |
| `s3:ListMultipartUploadParts` | Objects > 5 MB |
| `s3:AbortMultipartUpload` | Objects > 5 MB |

Minimal AWS IAM policy example:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:ListBucket",
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:ListBucketMultipartUploads",
        "s3:ListMultipartUploadParts",
        "s3:AbortMultipartUpload"
      ],
      "Resource": [
        "arn:aws:s3:::yhub",
        "arn:aws:s3:::yhub/*"
      ]
    }
  ]
}
```

## API Documentation

See [API.md](./API.md) for the REST API documentation including:

- WebSocket endpoints
- Permissions
- History, changeset and activity APIs
- Rollback & prune
- Custom API endpoints
- CORS
- YHub import API

## Benchmarks

See [benchmarks/README.md](./benchmarks/README.md) for the cost model — what each
operation a y/hub connection performs actually costs, and how it scales — and
[benchmarks/RESULTS.md](./benchmarks/RESULTS.md) for measurements. Run them with
`cd benchmarks && npm start`.
