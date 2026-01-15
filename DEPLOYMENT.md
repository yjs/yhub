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

---

## 2. Set Up PostgreSQL

Create a PostgreSQL database and the required tables:

```sql
CREATE TABLE IF NOT EXISTS yhub_updates_v1 (
    org             text,
    docid           text,
    branch          text DEFAULT 'main',
    gc              boolean DEFAULT true,
    r               SERIAL,
    update          bytea,
    sv              bytea,
    contentmap      bytea,
    PRIMARY KEY     (org, docid, branch, gc, r)
);

CREATE TABLE IF NOT EXISTS yhub_attributions_v1 (
    org         text,
    docid       text,
    branch      text DEFAULT 'main',
    contentmap  bytea,
    PRIMARY KEY (org, docid, branch)
);
```

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

**Environment variable:**

```bash
AUTH_PERM_CALLBACK=https://your-app.com/auth/perm
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
AUTH_PERM_CALLBACK=https://your-app.com/api/yhub/perm

# Server (optional)
PORT=3002

# Callbacks (optional)
YDOC_UPDATE_CALLBACK=https://your-app.com/api/yhub/update

# Logging (optional)
LOG=*
```

---

## 6. Initialize Database and Buckets

After configuring your environment, run:

```bash
npm run init
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
