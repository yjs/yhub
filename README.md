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
"room" is represented as a redis stream. The server component assembles updates
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
components coordinate which room needs to be persisted using a separate
worker-queue (see `y:worker` stream in redis).

You are responsible for providing a REST backend that y/hub will call to check
whether a specific client (authenticated via a JWT token) has access to a
specific room / document. Example servers can be found in
`/bin/auth-server-example.js` and `/demos/auth-express/server.js`.

## How Documents Are Stored

y/hub uses a hybrid storage approach optimized for both real-time performance
and durability.

### Real-time Layer (Redis)

When a client sends an update:
1. The update is published to a Redis stream (`{prefix}:room:{room}:{docid}:{branch}`)
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

```sql
-- Main updates table
CREATE TABLE yhub_ydoc_v1 (
    org         text,           -- Organization/namespace (the "room")
    docid       text,           -- Document identifier
    branch      text DEFAULT 'main',
    gc          boolean DEFAULT true,  -- Garbage collection enabled
    r           SERIAL,         -- Reference number
    update      bytea,          -- Encoded update reference (points to S3)
    sv          bytea,          -- State vector
    contentmap  bytea,          -- Attribution content map
    PRIMARY KEY (org, docid, branch, gc, r)
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

All features are configurable using environment variables. For local development
it makes sense to setup a `.env` file, that stores project-specific secrets. Use
`.env.template` as a template to setup environment variables.

### Required Settings

```bash
# Redis connection
REDIS=redis://localhost:6379
REDIS_PREFIX=y                    # Prefix for all Redis keys

# S3 storage (MinIO compatible)
S3_ENDPOINT=localhost
S3_PORT=9000
S3_SSL=false
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_YHUB_BUCKET=yhub               # Bucket for document storage

# PostgreSQL connection
POSTGRES=postgres://user:pass@localhost:5432/yhub

# Authentication keys (generate with: npx 0ecdsa-generate-keypair --name auth)
AUTH_PUBLIC_KEY={"kty":"EC",...}
AUTH_PRIVATE_KEY={"kty":"EC",...}

# Permission callback URL (your backend)
AUTH_PERM_CALLBACK=http://localhost:5173/auth/perm
```

### Optional Settings

```bash
# Server port
PORT=3002

# Testing database (for running tests)
POSTGRES_TESTING=postgres://user:pass@localhost:5432/yhub-testing
S3_YHUB_TEST_BUCKET=yhub-testing

# Document update callback (called when documents change)
YDOC_UPDATE_CALLBACK=http://localhost:5173/ydoc

# Logging (regex pattern)
LOG=*                             # Log everything
# LOG=@y/hub                      # Log only y/hub messages

# Expert settings
REDIS_MIN_MESSAGE_LIFETIME=60000  # Minimum message lifetime in Redis (ms)
REDIS_TASK_DEBOUNCE=10000         # Worker task debounce time (ms)
```

## Integration Guide

### 1. Set Up Infrastructure

Start the required services:

```bash
# Using Docker (or podman)
docker run -p 6379:6379 redis
docker run -p 5432:5432 -e POSTGRES_USER=yhub -e POSTGRES_PASSWORD=yhub postgres:16-alpine
docker run -p 9000:9000 -p 9001:9001 quay.io/minio/minio server /data --console-address ":9001"

# Or use the npm scripts
npm run redis
npm run postgres
npm run minio
```

### 2. Initialize the Database

```bash
npm run init
```

This creates the required PostgreSQL tables and S3 buckets.

### 3. Generate Authentication Keys

```bash
npx 0ecdsa-generate-keypair --name auth
```

Add the generated keys to your `.env` file as `AUTH_PUBLIC_KEY` and
`AUTH_PRIVATE_KEY`.

### 4. Implement the Permission Callback

y/hub calls your backend to check if a user has access to a document. Implement
this endpoint in your existing backend:

```javascript
// Express example
app.get('/auth/perm/:room/:userid', async (req, res) => {
  const { room, userid } = req.params

  // Check your database/business logic here
  const hasAccess = await checkUserAccess(userid, room)

  res.json({
    yroom: room,
    yaccess: hasAccess ? 'rw' : 'no-access',  // 'rw', 'read-only', or 'no-access'
    yuserid: userid
  })
})
```

### 5. Implement Token Generation

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

### 6. Connect from the Client

```javascript
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

// Get auth token from your backend
const authToken = await fetch('/auth/token').then(r => r.text())

const ydoc = new Y.Doc()
const provider = new WebsocketProvider(
  'ws://localhost:3002/ws',
  'my-document-room',
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

### 7. Start the Server

```bash
# Start both server and worker
npm start

# Or start them separately
npm run start:server
npm run start:worker
```

## Optional: Document Update Callback

If you set `YDOC_UPDATE_CALLBACK`, y/hub will call your endpoint when documents
change. This is useful for indexing, backups, or triggering other workflows:

```javascript
import formidable from 'formidable'
import * as Y from 'yjs'

app.put('/ydoc/:room', async (req, res) => {
  const room = req.params.room

  // Parse the multipart form data
  const form = formidable({})
  const [fields, files] = await form.parse(req)

  if (files.ydoc) {
    const ydocUpdate = await fs.readFile(files.ydoc[0].filepath)
    const ydoc = new Y.Doc()
    Y.applyUpdateV2(ydoc, ydocUpdate)

    // Do something with the document (index, backup, etc.)
    console.log('Document updated:', ydoc.toJSON())
  }

  res.sendStatus(200)
})
```

## Scaling

y/hub is designed for horizontal scaling:

1. **Multiple Server Instances**: Run multiple server instances behind a load
   balancer. Redis pub/sub ensures all instances receive updates.

2. **Multiple Workers**: Run multiple worker instances. Redis consumer groups
   ensure each task is processed exactly once.

3. **Database Scaling**: PostgreSQL and S3 can be scaled independently based on
   your needs.

### Missing Features

I'm looking for sponsors that want to sponsor the following work:

- Ability to kick out users when permissions on a document changed
- Configurable docker containers for y/hub server & worker
- Helm chart
- More exhaustive logging and reporting of possible issues
- More exhaustive testing
- Better documentation & more documentation for specific use-cases
- Support for Bun and Deno
- Perform expensive tasks (computing sync messages) in separate threads

If you are interested in sponsoring some of this work, please send a mail to
<kevin.jahns at pm.me>.

# Quick Start (docker-compose)

You can get everything running quickly using
[docker-compose](https://docs.docker.com/compose/). The compose file runs the
following components:

- redis
- minio as a s3 endpoint
- a single y/hub server
- a single y/hub worker

This can be a good starting point for your application. If your cloud provider
has a managed s3 service, you should probably use that instead of minio. If you
want to use minio, you need to setup proper volumes and backups.

The full setup gives insight into more specialized configuration options.

```sh
git clone https://github.com/yjs/yhub.git
cd yhub
npm i
```

# Full setup

Components are configured via environment variables. It makes sense to start by
cloning y/hub and getting one of the demos to work.

Note: If you want to use any of the docker commands, feel free to use podman (a
more modern alternative) instead.

#### Start a redis instance

Setup redis on your computer. Follow the [official
documentation](https://redis.io/docs/install/install-redis/). This is
recommended if you want to debug the redis stream.

Alternatively, simply run redis via docker:

```sh
npm run redis
```

### Start Postgres instance

```sh
npm run postgres
```

### Start MinIO (S3) instance

```sh
npm run minio
```

#### Clone demo

```sh
git clone https://github.com/yjs/yhub.git
cd yhub
npm i
```

Setup environment variables:

```sh
cp .env.template .env
nano .env
```

Then you can run the different components in separate terminals:

```sh
# run the server
npm run start:server
# run a single worker in a separate terminal
npm run start:worker
# start the express server in a separater terminal
cd demos/attributions
npm i
npm start
```

Open [`http://localhost:5173`](http://localhost:5173) in a browser.

## API Documentation

See [API.md](./API.md) for the REST API documentation including:

- WebSocket endpoints
- History and timestamps APIs
- Rollback functionality
- Webhook configuration
