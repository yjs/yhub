# Getting Started with YHub

## Installation

```bash
npm install @y/hub
```

## Basic Setup

```javascript
import { createYHub, createAuthPlugin, createDocumentPermissions } from '@y/hub'
import * as env from 'lib0/environment'

// what every user may do with every document
const grant = createDocumentPermissions({
  ydoc: 'cru-',      // positional crud mask, '-' denies: r = read/sync, u = write (c/d reserved, do nothing yet)
  awareness: '-ru-', // r = receive presence, u = broadcast own (c/d reserved)
  history: { from: 0, rollback: true, prune: false, version: 'crud' }, // from = 0 grants full history, version: named versions
  delete: ['soft'],  // destructive rights are opted into by name — never implied by a write mask
  endpoint: { '*': '-r--', comments: 'crud' } // rest endpoints + the websocket route ('ws'), '*' = fallback
})

const yhub = await createYHub({
  redis: {
    url: env.getConf('REDIS'),           // e.g. 'redis://localhost:6379'
    prefix: 'yhub'
  },
  postgres: env.getConf('POSTGRES'),      // e.g. 'postgres://user:pass@localhost:5432/db'
  persistence: [],
  // The auth plugin. Every function is optional and receives the yhub instance first - one you
  // leave out keeps the AuthPlugin default: an anonymous caller, a permissions getter that throws
  // (the routes of its scope answer 500), a batch check that asks its getter.
  auth: createAuthPlugin({
    // Return anything identifying the user, or null for an anonymous caller (the permissions are
    // then asked with authInfo = null). Throw apiError(401, ...) to reject a credential.
    authenticate: async (yhub, req) => ({ userid: 'anonymous' }),
    // One function per scope (getGlobalPermissions, getOrgPermissions, getBranchPermissions,
    // getDocumentPermissions). The list-taking ones answer { resource, permissions } for every
    // resource they are given, in order - the permission object, or null to deny; the permission
    // type is forced to match the scope. docRefs are { org, docid, branch } triples.
    // The batch check (filterAuthorizedDocuments: which of many documents hold one requirement,
    // e.g. `GET /updated` lists only the documents the caller may read) defaults to asking it.
    getDocumentPermissions: async (yhub, docRefs, authInfo) => docRefs.map(docRef => ({ resource: docRef, permissions: grant }))
  }),
  server: {
    port: 4400
  },
  worker: {
    taskConcurrency: 5
  }
})
```

## Authentication

### JWT Authentication

```javascript
import * as jwt from 'lib0/crypto/jwt'
import * as ecdsa from 'lib0/crypto/ecdsa'
import * as env from 'lib0/environment'

const publicKey = await ecdsa.importKeyJwk(JSON.parse(env.getConf('AUTH_PUBLIC_KEY')))

// Map the token's claims to a permission object - the same for every document.
const documentPermissions = authInfo => {
  const write = !authInfo.readonly // e.g. a `readonly` claim issued at sign-in
  return {
    type: 'permissions:document:v1',
    ydoc: write ? 'cru-' : '-r--',
    awareness: '-ru-',
    history: { from: 0 },
    endpoint: { '*': write ? 'crud' : '-r--' }
  }
}

const yhub = await createYHub({
  // ... redis, postgres, persistence config
  auth: createAuthPlugin({
    authenticate: async (yhub, req) => {
      const token = req.getQuery('yauth') // read the request before the first await
      // Verify the token and return its payload — the permissions receive it as `authInfo`
      const { payload } = await jwt.verifyJwt(publicKey, token)
      return payload
    },
    getDocumentPermissions: async (yhub, docRefs, authInfo) => docRefs.map(docRef => ({ resource: docRef, permissions: documentPermissions(authInfo) }))
  }),
  server: { port: 4400 },
  worker: { taskConcurrency: 5 }
})
```

Generate keypair for JWT:

```javascript
import * as ecdsa from 'lib0/crypto/ecdsa'

const keypair = await ecdsa.generateKeyPair()
const privateJwk = JSON.stringify(await ecdsa.exportKeyJwk(keypair.privateKey))
const publicJwk = JSON.stringify(await ecdsa.exportKeyJwk(keypair.publicKey))
// Store these in AUTH_PRIVATE_KEY and AUTH_PUBLIC_KEY env vars
```

### Cookie Authentication

```javascript
// One lookup per document. yhub asks for one document at a time today, so this is what each
// websocket upgrade and rest request costs.
const documentPermissions = (docRefs, authInfo) => Promise.all(docRefs.map(async docRef => {
  const hasAccess = await checkUserPermission(authInfo.userid, docRef.org, docRef.docid)
  // denial is a value — throwing means infrastructure failure
  if (!hasAccess) return { resource: docRef, permissions: null }
  return {
    resource: docRef,
    permissions: {
      type: 'permissions:document:v1',
      ydoc: 'cru-',
      awareness: '-ru-',
      history: { from: 0 },
      endpoint: { '*': 'crud' }
    }
  }
}))

createAuthPlugin({
  authenticate: async (yhub, req) => {
    const cookies = parseCookies(req.getHeader('cookie')) // read the request before the first await
    const session = await validateSession(cookies.sessionId)
    return { userid: session.userId }
  },
  // The batch check defaults to this getter: correct, but one permission lookup per document -
  // answer many documents from one query instead (API.md, "Batch checks").
  getDocumentPermissions: async (yhub, docRefs, authInfo) => await documentPermissions(docRefs, authInfo)
})
```

`createAuthPlugin` builds a subclass of `AuthPlugin` whose methods bound every call by the
timeout, check every answer and normalize the permissions - safety guards you usually want. You
can also extend `AuthPlugin` by hand, but such a class is called as written, without them (see
[Extending AuthPlugin](./API.md#extending-authplugin)).

## Separate Workers and Servers (Recommended)

For production, run workers and servers as separate processes for better scaling and reliability.

**server.js** - Handles WebSocket connections:

```javascript
import { createYHub, createAuthPlugin } from '@y/hub'
import * as env from 'lib0/environment'

await createYHub({
  redis: { url: env.getConf('REDIS'), prefix: 'yhub' },
  postgres: env.getConf('POSTGRES'),
  persistence: [],
  auth: createAuthPlugin({ /* ... */ }),
  server: { port: 4400 },
  worker: null  // No worker in this process
})
```

**worker.js** - Persists data to database:

```javascript
import { createYHub } from '@y/hub'
import * as env from 'lib0/environment'

await createYHub({
  redis: { url: env.getConf('REDIS'), prefix: 'yhub' },
  postgres: env.getConf('POSTGRES'),
  persistence: [],
  server: null,  // No server in this process
  worker: { taskConcurrency: 5 }
})
```

## S3 Persistence Plugin

By default, YHub stores document data directly in PostgreSQL. For large documents or when you want to leverage S3-compatible storage (AWS S3, RustFS, etc.), you can use the S3 persistence plugin to store document data in S3 while keeping metadata in PostgreSQL.

### Setup

```javascript
import { createYHub, createAuthPlugin } from '@y/hub'
import { S3PersistenceV1 } from '@y/hub/plugins/s3'
import * as env from 'lib0/environment'

const yhub = await createYHub({
  redis: {
    url: env.getConf('REDIS'),
    prefix: 'yhub'
  },
  postgres: env.getConf('POSTGRES'),  // Still required for metadata
  persistence: [
    new S3PersistenceV1({
      bucket: env.getConf('S3_YHUB_BUCKET'),
      endPoint: env.getConf('S3_ENDPOINT'),      // e.g. 's3.amazonaws.com' or 'localhost'
      port: parseInt(env.getConf('S3_PORT')),    // e.g. 443 for AWS, locally the port allocated by 'npm run dev:env'
      useSSL: env.getConf('S3_SSL') === 'true',
      accessKey: env.getConf('S3_ACCESS_KEY'),
      secretKey: env.getConf('S3_SECRET_KEY')
    })
  ],
  auth: createAuthPlugin({ /* ... */ }),
  server: {
    port: 4400
  },
  worker: {
    taskConcurrency: 5
  }
})
```

### Environment Variables

```bash
# S3 configuration
S3_ENDPOINT=localhost       # 's3.amazonaws.com' for AWS S3
S3_PORT=9010               # 443 for AWS S3
S3_SSL=false               # true for AWS S3
S3_ACCESS_KEY=your-access-key
S3_SECRET_KEY=your-secret-key
S3_YHUB_BUCKET=yhub
```

### How It Works

- **PostgreSQL** stores document metadata and references (small pointers)
- **S3** stores the actual document data (Yjs updates, content maps)
- The plugin persists every branch by default; `branches: ['main']` restricts offloading to the listed branches — skipped branches store their data inline in PostgreSQL
- On a versioning-enabled bucket the plugin deletes the object version it recorded when storing; `deleteVersions: false` leaves delete markers instead, keeping the bytes restorable
- On startup, the plugin automatically creates the bucket if it doesn't exist

### Running an S3 Store Locally

Any S3-compatible object store works. In the y/hub repository `npm run dev:up` starts
[RustFS](https://github.com/rustfs/rustfs) (Apache-2.0) for you; in your own project a
minimal compose file looks like this:

```yaml
# docker-compose.yml
services:
  s3:
    image: docker.io/rustfs/rustfs:1.0.0
    environment:
      RUSTFS_ACCESS_KEY: yhub-dev-access-key
      RUSTFS_SECRET_KEY: yhub-dev-secret-key
    ports:
      - "127.0.0.1:9010:9000"   # S3 API
      - "127.0.0.1:9011:9001"   # Console
    volumes:
      - s3-data:/data

volumes:
  s3-data:
```

Then configure with:
```bash
S3_ENDPOINT=localhost
S3_PORT=9010
S3_SSL=false
S3_ACCESS_KEY=yhub-dev-access-key
S3_SECRET_KEY=yhub-dev-secret-key
S3_YHUB_BUCKET=yhub
```

## Docker

### Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
CMD ["node", "server.js"]
```

### docker-compose.yml

```yaml
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: yhub
      POSTGRES_PASSWORD: yhub
      POSTGRES_DB: yhub
    ports: ["5432:5432"]

  yhub-server:
    build: .
    command: node server.js
    environment:
      REDIS: redis://redis:6379
      POSTGRES: postgres://yhub:yhub@postgres:5432/yhub
      AUTH_PUBLIC_KEY: ${AUTH_PUBLIC_KEY}  # the app's token verification key — consumed by your auth plugin, not by yhub
    ports: ["4400:4400"]
    depends_on: [redis, postgres]
    deploy:
      replicas: 2  # Scale servers horizontally

  yhub-worker:
    build: .
    command: node worker.js
    environment:
      REDIS: redis://redis:6379
      POSTGRES: postgres://yhub:yhub@postgres:5432/yhub
    depends_on: [redis, postgres]
    deploy:
      replicas: 1  # Usually 1-2 workers suffice
```

## Client Connection

Clients connect via WebSocket with auth token as query parameter:

```
ws://localhost:4400/api/ws/v1/{org}/{docid}?yauth={token}&branch={branch}
```

- `org` - Organization/namespace
- `docid` - Document identifier
- `yauth` - Authentication token
- `branch` - Optional, defaults to "main"

On disconnect, reconnect with backoff — unless the close code is in `4400`–`4499` (permanent,
e.g. `4401` permission revoked). See [API.md → Errors](API.md#errors).
