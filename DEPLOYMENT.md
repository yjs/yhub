# Y/Hub Deployment Guide

This guide covers setting up y/hub infrastructure for production.

## Required Services

| Service    | Purpose                     |
|------------|-----------------------------|
| Redis      | Real-time message passing   |
| PostgreSQL | Document metadata storage   |
| S3         | Document blob storage       |

Any S3-compatible storage works (AWS S3, Cloudflare R2, MinIO, etc.).

---

## 1. Set Up Redis

Provision a Redis instance. y/hub uses Redis streams and pub/sub for real-time
updates.

**Environment variable:**

```bash
REDIS=redis://localhost:6379
REDIS_PREFIX=yhub
```

### Eviction policy

Configure Redis / Valkey with the `volatile-lru` eviction policy:

```
maxmemory-policy volatile-lru
```

y/hub sets an expiry only on cached HTTP API responses. Update streams are
written without a TTL, so `volatile-lru` reclaims memory from the cache while
leaving the streams untouched.

Do **not** use `allkeys-lru`, `allkeys-lfu`, or `allkeys-random` — these evict
update streams, which causes **data loss**.

### Memory sizing

Redis is not just a cache — it is the authoritative store for updates that have
not yet been persisted. Client updates are appended to a stream, and the worker
only trims a stream after it has merged and written the document to S3 and
PostgreSQL. Anything evicted or lost before that point is gone.

Size the instance so that all transient updates fit in memory at peak load,
with headroom. If Redis cannot hold them, `volatile-lru` will start failing
writes once the cache is exhausted (which surfaces as errors) rather than
silently dropping streams — but the safe configuration is enough memory for the
full working set.

Persistence (AOF/RDB) is recommended as well, so that a Redis restart does not
discard updates that the worker has not yet persisted.

---

## 2. Set Up PostgreSQL

Create a PostgreSQL database, then create the tables with `npm run start:init`
(`bin/init-db.js`) — it is idempotent, so re-running it is safe. See
[STORAGE-ARCHITECTURE.md](./STORAGE-ARCHITECTURE.md#postgresql-table-layout) for the schema.

Servers and workers never run DDL themselves, so the credentials they run with need no DDL rights
— but it also means **`npm run start:init` has to be re-run when upgrading to a release that adds
a table**, before the new version starts. Releases that add one say so in the changelog; a missing
table surfaces as `relation "..." does not exist` on the first request that needs it.

**Environment variable:**

```bash
POSTGRES=postgres://user:password@host:5432/database
```

---

## 3. Set Up S3 Bucket

Create an S3 bucket for storing document blobs. The bucket name is configurable.

**Environment variables:**

```bash
S3_ENDPOINT=s3.amazonaws.com    # or your S3-compatible endpoint
S3_PORT=443
S3_SSL=true
S3_ACCESS_KEY=your-access-key
S3_SECRET_KEY=your-secret-key
S3_YHUB_BUCKET=yhub
```

---

## 4. Configure Authentication

You need to implement an auth server that handles two endpoints. See
`bin/auth-server-example.js` for a complete working example.

### Authentication Flow

```
┌────────┐         ┌─────────────┐         ┌────────┐
│ Client │         │ Auth Server │         │ Y/Hub  │
└───┬────┘         └──────┬──────┘         └───┬────┘
    │                     │                    │
    │ 1. GET /auth/token  │                    │
    │────────────────────▶│                    │
    │                     │                    │
    │ 2. JWT with yuserid │                    │
    │◀────────────────────│                    │
    │                     │                    │
    │ 3. Connect WebSocket with JWT            │
    │─────────────────────────────────────────▶│
    │                     │                    │
    │                     │ 4. GET /auth/perm/:room/:userid
    │                     │◀───────────────────│
    │                     │                    │
    │                     │ 5. { yaccess: 'rw' }
    │                     │───────────────────▶│
    │                     │                    │
    │ 6. Connection accepted                   │
    │◀─────────────────────────────────────────│
```

### Generate ECDSA Keys

```bash
npx 0ecdsa-generate-keypair --name auth
```

Add the generated keys to your environment:

```bash
AUTH_PUBLIC_KEY={"kty":"EC","crv":"P-384",...}
AUTH_PRIVATE_KEY={"kty":"EC","crv":"P-384",...,"d":"..."}
```

### Implement Token Endpoint

The client requests a JWT from your auth server. You authenticate the user
(via session, OAuth, etc.) and return a signed JWT containing their user ID:

```javascript
// GET /auth/token
app.get('/auth/token', async (req, res) => {
  // Authenticate the user with your existing auth system
  const userId = req.session.userId

  const token = await jwt.encodeJwt(authPrivateKey, {
    iss: 'your-app-name',
    exp: time.getUnixTime() + 60 * 60 * 1000,  // 1 hour expiry
    yuserid: userId  // Required: unique user identifier
  })

  res.send(token)
})
```

### Implement Permission Callback

When a client connects to y/hub, it calls your permission endpoint to check
access. Return the access level for this user and room:

```javascript
// GET /auth/perm/:room/:userid
app.get('/auth/perm/:room/:userid', async (req, res) => {
  const { room, userid } = req.params

  // Check your database for user permissions
  const access = await checkUserAccess(userid, room)

  res.json({
    yroom: room,
    yaccess: access,  // 'rw', 'read-only', or 'no-access'
    yuserid: userid
  })
})
```

---

## 5. Full Environment Configuration

```bash
# Redis
REDIS=redis://localhost:6379
REDIS_PREFIX=yhub

# PostgreSQL
POSTGRES=postgres://user:password@host:5432/database

# S3
S3_ENDPOINT=s3.amazonaws.com
S3_PORT=443
S3_SSL=true
S3_ACCESS_KEY=your-access-key
S3_SECRET_KEY=your-secret-key
S3_YHUB_BUCKET=yhub

# Authentication
AUTH_PUBLIC_KEY=...
AUTH_PRIVATE_KEY=...

# Server (optional)
PORT=4400
# Origin(s) allowed to call the api from a browser - comma-separated for an allowlist, an entry
# may start its host with '*.': https://*.example.com matches every host under example.com. While unset,
# cross-origin browser access is closed (same-origin pages and non-browser clients always work);
# '*' opens the api to every origin and logs a warning. Cross-origin websocket connections and
# api requests are denied unless the origin is allowed - browsers do not apply cors to those
# requests, so yhub does.
CORS_ORIGIN=https://app.example.com
# Max request header bytes (cookies included); requests over it are rejected with 431.
# uWebSockets.js default: 4096. Must be present in the environment at process startup.
# UWS_HTTP_MAX_HEADERS_SIZE=32768

# Logging (optional): trace | debug | info | warn | error | fatal | silent
LOG_LEVEL=info
```

---

## 6. Initialize Database and Buckets

After configuring your environment, run:

```bash
npm run start:init
```

This creates the PostgreSQL tables and S3 bucket if they don't exist.

---

## 7. Run the Worker

The worker handles persistence and cleanup:

```bash
npm run start:worker
```

Run at least one worker instance. Multiple workers can run in parallel for
higher throughput.

---

## 8. Run the Server

The server handles WebSocket connections:

```bash
npm run start:server
```

Multiple server instances can run behind a load balancer. Ensure the load
balancer supports WebSocket upgrades.
