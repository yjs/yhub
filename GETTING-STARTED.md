# Getting Started with YHub

## Installation

```bash
npm install @y/hub
```

## Basic Setup

```javascript
import { createYHub, createAuthPlugin } from '@y/hub'
import * as env from 'lib0/environment'

const yhub = await createYHub({
  redis: {
    url: env.getConf('REDIS'),           // e.g. 'redis://localhost:6379'
    prefix: 'yhub'
  },
  postgres: env.getConf('POSTGRES'),      // e.g. 'postgres://user:pass@localhost:5432/db'
  persistence: [],
  server: {
    port: 3000,
    auth: createAuthPlugin({
      async readAuthInfo(req) {
        return { userid: 'anonymous' }
      },
      async getAccessType(authInfo, room) {
        return 'rw' // 'rw' | 'r' | null
      }
    })
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

const yhub = await createYHub({
  // ... redis, postgres, persistence config
  server: {
    port: 3000,
    auth: createAuthPlugin({
      async readAuthInfo(req) {
        const token = req.getQuery('yauth')
        const payload = await jwt.decodeJwt(publicKey, token)
        return { userid: payload.yuserid }
      },
      async getAccessType(authInfo, room) {
        // Check permissions based on authInfo.userid and room
        // room = { org: string, docid: string, branch: string }
        return 'rw'
      }
    })
  },
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
createAuthPlugin({
  async readAuthInfo(req) {
    const cookies = parseCookies(req.getHeader('cookie'))
    const session = await validateSession(cookies.sessionId)
    return { userid: session.userId }
  },
  async getAccessType(authInfo, room) {
    const hasAccess = await checkUserPermission(authInfo.userid, room.org, room.docid)
    return hasAccess ? 'rw' : null
  }
})
```

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
  server: { port: 3000, auth: createAuthPlugin({ /* ... */ }) },
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

By default, YHub stores document data directly in PostgreSQL. For large documents or when you want to leverage S3-compatible storage (AWS S3, MinIO, etc.), you can use the S3 persistence plugin to store document data in S3 while keeping metadata in PostgreSQL.

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
      bucket: env.getConf('S3_BUCKET'),
      endPoint: env.getConf('S3_ENDPOINT'),      // e.g. 's3.amazonaws.com' or 'localhost'
      port: parseInt(env.getConf('S3_PORT')),    // e.g. 443 for AWS, 9000 for MinIO
      useSSL: env.getConf('S3_SSL') === 'true',
      accessKey: env.getConf('S3_ACCESS_KEY'),
      secretKey: env.getConf('S3_SECRET_KEY')
    })
  ],
  server: {
    port: 3000,
    auth: createAuthPlugin({ /* ... */ })
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
S3_PORT=9000               # 443 for AWS S3
S3_SSL=false               # true for AWS S3
S3_ACCESS_KEY=your-access-key
S3_SECRET_KEY=your-secret-key
S3_BUCKET=yhub
```

### How It Works

- **PostgreSQL** stores document metadata and references (small pointers)
- **S3** stores the actual document data (Yjs updates, content maps)
- The plugin only persists documents on the `main` branch
- On startup, the plugin automatically creates the bucket if it doesn't exist

### Using MinIO for Local Development

MinIO is an S3-compatible object storage that runs locally:

```yaml
# docker-compose.yml
services:
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "9000:9000"   # S3 API
      - "9001:9001"   # Console
    volumes:
      - minio-data:/data

volumes:
  minio-data:
```

Then configure with:
```bash
S3_ENDPOINT=localhost
S3_PORT=9000
S3_SSL=false
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=yhub
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
      AUTH_PUBLIC_KEY: ${AUTH_PUBLIC_KEY}
    ports: ["3000:3000"]
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
ws://localhost:3000/ws/{org}/{docid}?yauth={token}&branch={branch}
```

- `org` - Organization/namespace
- `docid` - Document identifier
- `yauth` - Authentication token
- `branch` - Optional, defaults to "main"
