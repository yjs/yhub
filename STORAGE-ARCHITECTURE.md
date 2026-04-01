# YHub Storage Architecture

This document describes the data models, schemas, and storage architecture introduced in the latest version of YHub.

## Overview

YHub uses a dual-storage architecture:
- **PostgreSQL** for persistent document state
- **Redis Streams** for real-time message distribution and task queues

All binary content follows a versioned schema approach, enabling future format migrations without breaking compatibility.

## Goals

- **FAST** lookups of documents and editing traces
- Better integration of collab into existing backends
- Plugin architecture for persistence, task management, custom callbacks on events
- Future compatibility
- infinitely scalable
- In the future: **LOCAL FIRST**, sync all organization documents

---

## Rooms

"rooms" is the concept how we share data. Data in the same "room" is shared. The
websocket provider subscribes to rooms. For most applications we connect to a
single document: `room = { org: string, docid: string, branch: string }`.

In future releases, we could also subscribe to all documents in a whole
organization (for offline sync): `room = { org: string }`.

## Binary Content Schemas

All binary data in YHub has an explicit schema with version information. This approach enables:
- Forward compatibility when introducing new encodings
- Safe migrations between schema versions
- Type-safe serialization using lib0's schema-based encoding

### Introduced Schemas

| Schema | Version | Purpose |
|--------|---------|---------|
| `id:ydoc:v1` | v1 | Y.js document asset identifier |
| `id:contentmap:v1` | v1 | Content map asset identifier |
| `id:contentids:v1` | v1 | Content IDs asset identifier |
| `asset:ydoc:v1` | v1 | Binary-encoded Y.js update |
| `asset:contentmap:v1` | v1 | Content map binary data |
| `asset:contentids:v1` | v1 | Content IDs binary data |
| `asset:retrievable:v1` | v1 | Reference to external storage (plugin) |
| `ydoc:update:v1` | v1 | Y.js update message (Redis) |
| `awareness:v1` | v1 | Awareness protocol message (Redis) |
| `compact` | current | Document compaction task |

---

## PostgreSQL Table Layout

### Table: `yhub_ydoc_v1`

```sql
CREATE TABLE yhub_ydoc_v1 (
    org             text,
    docid           text,
    branch          text,
    t               text,       -- redis identifier (timestamp)
    created         INT8,       -- Unix timestamp in milliseconds
    gcDoc           bytea,      -- Garbage-collected Y.js update
    nongcDoc        bytea,      -- Non-garbage-collected Y.js update
    contentmap      bytea,      -- Content map binary
    contentids      bytea,      -- Content IDs binary
    PRIMARY KEY     (org, docid, branch, t)
);
```

### Design Rationale

This simplified table layout provides several advantages:

1. **Persistence Plugin Integration**: Each column stores schema-encoded assets that can be intercepted by persistence plugins (e.g., S3 via `S3PersistenceV1`, or any cloud storage via `BlobPersistence`) before storage. When a plugin handles an asset, a `asset:retrievable:v1` reference is stored instead.

2. **Partial Non-GC Document Retrieval**: By storing non-garbage-collected documents (`nongcDoc`) at regular intervals with timestamps, we can query for recent non-GC states without loading years of history. This enables efficient retrieval of document versions with full edit history for recent changes only.

3. **Multiple Versions Per Document**: The composite primary key `(org, docid, branch, t)` allows storing multiple snapshots of each document over time, supporting:
   - Point-in-time recovery
   - Incremental compaction
   - Audit trails

4. **Selective Column Loading**: Queries can request only the columns needed (gc, nongc, contentmap, contentids), avoiding unnecessary data transfer.

---

## Assets and AssetIds

### Asset Identifier Structure

Asset IDs uniquely identify stored content and encode enough information for retrieval and caching:

```javascript
// Y.js Document Asset ID
{
  type: 'id:ydoc:v1',
  org: string,      // Organization namespace
  docid: string,    // Document identifier
  branch: string,   // Branch name (e.g., 'main')
  t: string,        // Timestamp clock (e.g., "1704067200000-1")
  gc: boolean       // Whether this is garbage-collected
}

// Content Map Asset ID
{
  type: 'id:contentmap:v1',
  org: string,
  docid: string,
  branch: string,
  t: string
}

// Content IDs Asset ID
{
  type: 'id:contentids:v1',
  org: string,
  docid: string,
  branch: string,
  t: string
}
```

### Asset String Format

Asset IDs are serialized to strings for use as cache keys and storage paths:

```
id:ydoc:v1/{org}/{docid}/{branch}/{gc:0|1}/{timestamp}
id:contentmap:v1/{org}/{docid}/{branch}/{timestamp}
id:contentids:v1/{org}/{docid}/{branch}/{timestamp}
```

### Caching Strategy

The asset ID system enables flexible caching solutions:

- **Cache Keys**: The deterministic string format creates stable cache keys
- **Plugin-Based Caching**: A persistence plugin can implement Redis-backed caching by:
  1. Intercepting `store()` calls to cache assets
  2. Intercepting `retrieve()` calls to check cache before storage
  3. Using asset ID strings as Redis keys
- **TTL-Based Expiration**: Cache entries can use the `created` timestamp for TTL policies
- **Branch-Aware Caching**: Different branches can have different caching policies

Example cache implementation as a persistence plugin:

```javascript
{
  async store(assetId, asset) {
    const key = assetIdToString(assetId)
    await redis.setex(key, TTL, encode(asset))
    return null  // Continue to next plugin
  },

  async retrieve(assetId, assetInfo) {
    const key = assetIdToString(assetId)
    const cached = await redis.get(key)
    return cached ? decode(cached) : null
  }
}
```

---

## Y.js Document Memory Management

### Lazy Loading

The Y.js document (`ydoc`) is rarely loaded into memory. The system is designed to:

1. **Stream Updates Directly**: Updates flow through Redis streams without instantiating Y.js documents
2. **Compact Without Full Load**: Document compaction merges binary updates without creating Y.js instances when possible
3. **Defer Parsing**: Binary updates are stored and forwarded as-is

### Non-GC Documents

The non-garbage-collected document (`nongcDoc`) is **never** loaded into memory during normal operations. It exists solely for:

- Historical retrieval of full edit sequences
- Compliance/audit requirements
- Recovery scenarios

By storing non-GC snapshots at regular intervals, clients needing edit history can retrieve only recent non-GC data rather than the complete document history.

---

## Task Queue (Redis)

### Architecture

YHub uses Redis Streams for distributed task processing:

- **Worker Stream**: `{prefix}:worker` (default: `yhub:worker`)
- **Consumer Group**: `{prefix}:worker`
- **Consumer Name**: UUID per worker instance

### Task Structure

Currently, the task queue supports document compaction tasks:

```javascript
{
  type: 'compact',
  room: {
    org: string,
    docid: string,
    branch: string
  },
  redisClock: string   // Redis stream message ID for correlation
}
```

### Task Lifecycle

1. **Creation**: When a new message arrives for a room with no existing stream, a `compact` task is added to the worker queue
2. **Debounce**: Tasks have a configurable delay (default: 10 seconds) before being claimed, allowing message batching
3. **Processing**: Worker claims task, compacts document, persists to PostgreSQL
4. **Completion**: Task removed, Redis stream trimmed
5. **Continuation**: If messages remain after trim, a new task is re-queued

### Use Cases

The task queue triggers actions when document events occur:

- **Document Compaction**: Merge incremental updates into consolidated state
- **Callback URLs**: Notify external services of document changes
- **Custom Handlers**: Extensible event processing

---

## Redis Message Schemas

Messages distributed via Redis Streams follow versioned schemas:

### Update Message (`ydoc:update:v1`)

```javascript
{
  type: 'update:v1',
  update: Uint8Array,              // Y.js binary update
  attributions: Uint8Array | null  // Optional attribution data
}
```

### Awareness Message (`awareness:v1`)

```javascript
{
  type: 'awareness:v1',
  update: Uint8Array   // Awareness protocol binary data
}
```

### Stream Storage Format

- **Room Streams**: `{prefix}:room:{org}:{docid}:{branch}` (URL-encoded components)
- **Message Field**: Each message stored with field `m` containing the encoded buffer
- **Clock Format**: `"{timestamp}-{sequence}"` (e.g., `"1704067200000-5"`)

### Message Lifecycle

1. Messages added to room streams via `XADD`
2. Subscribers receive messages via `XREAD` with blocking
3. Messages retained for minimum lifetime (default: 1 minute)
4. Trimmed during compaction based on age

---

## Persistence Plugins

### Plugin Interface

```typescript
interface PersistencePlugin {
  pluginid: string;

  // Initialize plugin (e.g., create buckets)
  init?(api: Api): Promise<void>;

  // Store asset, return retrievable reference or null to continue chain
  store?(assetId: AssetId, asset: Asset): Promise<RetrievableAsset | null>;

  // Retrieve asset from external storage
  retrieve?(assetId: AssetId, assetInfo: Asset): Promise<Asset | null>;

  // Delete asset from external storage
  delete?(assetId: AssetId, assetInfo: Asset): Promise<boolean>;
}
```

### Built-in: S3 Persistence (`S3PersistenceV1`)

The `S3PersistenceV1` plugin offloads assets to S3-compatible storage (MinIO, AWS S3) using the `minio` SDK:

- **Storage Path**: Uses asset ID string as S3 object key
- **Branch Filter**: Only stores assets from `main` branch
- **Retries**: Handles transient network errors (connection resets, 503, 429) with one automatic retry
- **Returns**: `{ type: 'asset:retrievable:v1', plugin: 'S3Persistence:v1' }`

Import: `import { S3PersistenceV1 } from '@y/hub/plugins/s3'`

### Generic: Blob Persistence (`BlobPersistence`)

The `BlobPersistence` plugin is a generic alternative to `S3PersistenceV1` for cloud storage backends that are not S3-compatible (Azure Blob Storage, Google Cloud Storage, etc.). Instead of bundling a specific SDK, the caller provides a simple adapter with four operations:

| Method | Signature | Description |
|--------|-----------|-------------|
| `put` | `(path: string, data: Buffer) => Promise<void>` | Store a blob. Caller handles retries. |
| `get` | `(path: string) => Promise<Buffer\|null>` | Retrieve a blob. Return `null` if not found. |
| `del` | `(path: string) => Promise<void>` | Delete a blob. Must not throw if missing. |
| `init` | `() => Promise<void>` | *(Optional)* One-time setup (e.g. create container/bucket). |

- **Storage Path**: Same asset ID string format as S3PersistenceV1
- **Branch Filter**: Only stores assets from `main` branch (same as S3)
- **Encoding**: Same `lib0/buffer.encodeAny` / `decodeAny` as S3
- **Deletion**: Delayed 10 seconds to prevent stale reads (same as S3)
- **Returns**: `{ type: 'asset:retrievable:v1', plugin: '<pluginId>' }`

Import: `import { BlobPersistence } from '@y/hub/plugins/blob'`

```javascript
// Azure Blob Storage example
const plugin = new BlobPersistence('AzureBlob:v1', {
  init: () => container.createIfNotExists(),
  put: (path, data) => container.getBlockBlobClient(path).upload(data, data.length),
  get: async (path) => { /* return Buffer or null on 404 */ },
  del: (path) => container.getBlockBlobClient(path).deleteIfExists()
})

createYHub({ persistence: [plugin], ... })
```

### Plugin Chain

Multiple plugins can be chained:
1. Each `store()` call passes through plugins in order
2. First plugin returning a `RetrievableAsset` stops the chain
3. Remaining plugins see the reference, not the original asset

---

## Schema Versioning Strategy

All schemas follow the pattern `{category}:{name}:{version}`:

- **Category**: `id`, `asset`, `ydoc`, `awareness`, etc.
- **Name**: Specific type within category
- **Version**: `v1`, `v2`, etc.

This enables:
- Adding new versions without breaking existing data
- Parallel support for multiple versions during migration
- Clear identification of data format in storage
