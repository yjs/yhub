# Y/Hub Deployment Guide

This guide covers setting up y/hub infrastructure for production.

## Required Services

| Service    | Purpose                     |
|------------|-----------------------------|
| Redis      | Real-time message passing   |
| PostgreSQL | Document metadata storage   |
| S3         | Document blob storage       |

Any S3-compatible storage works: AWS S3, Cloudflare R2, or a self-hosted store such as RustFS or
VersityGW. MinIO's community edition is archived and its Docker images were removed in September 2026.

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

Authentication runs in-process — there is no separate auth server. Your
application issues the client a token (a JWT or a session cookie), and the auth
plugin you pass to y/hub verifies it and answers permission questions per
document:

1. The client fetches a token from your application and connects to y/hub with it.
2. `authenticate(req)` verifies the token and returns the user object.
3. For each document the client opens, y/hub calls
   `authorize('document', docRef, user)` — return that user's permission object,
   or `null` to deny.

### Implement the auth plugin

Build the plugin with `createAuthPlugin` from `@y/hub` and pass it as
`conf.server.auth`:

```javascript
import { createAuthPlugin, createAuthorize } from '@y/hub'

const auth = createAuthPlugin({
  async authenticate (req) {
    // Verify the JWT (or session cookie) the client sent. Return an object
    // with at least { userid } — it is handed to authorize() as `user`.
    // Return null for an anonymous caller (authorize() then gets user = null);
    // throw apiError(401, ...) to reject a bad credential, apiError(503, ...)
    // for a temporary auth-backend outage. Any other throw answers 503.
    const { payload } = await jwt.verifyJwt(authPublicKey, readToken(req))
    return { userid: payload.yuserid }
  },
  // One handler per scope - scopes without a handler deny, and each handler's return type is
  // forced to match its scope. Return the permission object, or null to deny - denial is a
  // value, never a throw; a throw means infrastructure failure.
  authorize: createAuthorize({
    document: async (docRef, user) => {
      const access = await checkUserAccess(user.userid, docRef)
      if (access == null) return null // deny
      return {
        type: 'permissions:document:v1',
        ydoc: access.write ? 'cru-' : '-r--', // positional crud mask: create/read/update/delete
        awareness: '-ru-',                    // r = receive presence, u = broadcast own
        history: { from: 0 },                 // from-ray, unix ms; 0 = full history
        delete: [],                           // deletion kinds granted by name, e.g. ['soft']
        endpoint: { '*': access.write ? 'crud' : '-r--' }  // rest endpoints + the websocket route ('ws'), '*' = fallback
      }
    }
  })
})
```

Schemas, sanitizers, and permission combinators are exported from
`@y/hub/permissions`.

### Issue tokens from your application

Your application authenticates the user however it already does (session,
OAuth, etc.) and hands the client a signed token to present to y/hub. If you
use JWTs, generate a keypair:

```bash
npx 0ecdsa-generate-keypair --name auth
```

The private key stays with your application's token endpoint; `authenticate()`
needs only the public key.

```javascript
// GET /auth/token — served by your application, not by y/hub
app.get('/auth/token', async (req, res) => {
  // Authenticate the user with your existing auth system
  const userId = req.session.userId

  const token = await jwt.encodeJwt(authPrivateKey, {
    iss: 'your-app-name',
    exp: time.getUnixTime() + 60 * 60 * 1000,  // 1 hour expiry
    yuserid: userId  // unique user identifier, read back by authenticate()
  })

  res.send(token)
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

# Authentication — read by your application (token endpoint + auth plugin),
# not by y/hub itself
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

# Graceful shutdown (optional): ms that SIGTERM/SIGINT wait at most for running compaction tasks
# and for websocket clients to acknowledge the close
SHUTDOWN_DRAIN_MS=15000
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

---

## 9. Shut Down Gracefully

`bin/server.js`, `bin/worker.js` and `bin/yhub.js` shut down on `SIGTERM` (what orchestrators
send) and `SIGINT` (Ctrl-C), calling [`yhub.destroy`](API.md#yhubdestroyopts):

* The worker stops claiming tasks and waits for the running ones, keeping their leases alive so
  no other worker reclaims them meanwhile.
* The server stops accepting connections and closes every websocket with `4503` (server shutting
  down). That code is transient: clients reconnect, and land on another instance.
* Then the redis, postgres and compute-pool resources are released and the process exits by
  itself, with code 0.

Both waits are bounded by `SHUTDOWN_DRAIN_MS` (default 15 000) and run at the same time. That is an
upper bound for slow compactions: closing the websockets takes milliseconds, and the process exits
as soon as the running tasks are done. A task that is still running when the time is up is
reclaimed by another worker after `REDIS_TASK_DEBOUNCE`. Pressing Ctrl-C a second time kills the
process at once.

The S3 plugin deletes superseded objects 10 seconds after a compaction replaced them. Those
pending deletes keep the process alive until they have run, so the process can stay up for that
long after the drain.

Give the process time to finish before it is killed. In the worst case a worker takes
`SHUTDOWN_DRAIN_MS` plus about 13 seconds: the delete delay, and one retry of a delete that hit a
transient S3 error. That is about 28 seconds with the defaults. A server without a worker exits
within milliseconds, unless a hard deletion just queued S3 deletes.

* Kubernetes: the default `terminationGracePeriodSeconds` of 30 covers the defaults. Raise it by
  as much as you raise `SHUTDOWN_DRAIN_MS`.
* Docker: the default stop timeout of 10 seconds is too short for a worker. Set
  `stop_grace_period: 30s` in compose (the bundled `compose.yaml` does), or pass
  `docker stop -t 30`. An image can't set this itself.

A process killed with `SIGKILL` drops its connections without a close frame. Its tasks are
reclaimed after `REDIS_TASK_DEBOUNCE` and nothing is lost, but any pending S3 deletes are
orphaned.
