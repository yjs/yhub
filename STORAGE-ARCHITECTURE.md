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

## Documents

The document is the unit of sharing. Data in the same document is shared, and
the websocket provider subscribes to documents. A document is addressed by a
DocRef: `docRef = { org: string, docid: string, branch: string }`.

In future releases, we could also subscribe to all documents in a whole
organization (for offline sync): `docRef = { org: string }`.

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
| `ydoc:tombstone:v1` | v1 | Document deletion notice (Redis) |
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
    -- whether the column above holds an `asset:retrievable:v1` pointer or the bytes themselves
    gcDoc_is_reference      boolean NOT NULL DEFAULT true,
    nongcDoc_is_reference   boolean NOT NULL DEFAULT true,
    contentmap_is_reference boolean NOT NULL DEFAULT true,
    contentids_is_reference boolean NOT NULL DEFAULT true,
    PRIMARY KEY     (org, docid, branch, t)
);
```

The `_is_reference` markers let a reader that only wants the references — the purge — leave inline
blobs in the database instead of reading them out to discard them. Decided **per asset**, since
`PersistencePlugin.store` is called once per asset and may offload some and not others;
`S3PersistenceV1` happens to decide by branch, offloading only `main`, which is why the saving lands
on branches rather than on main.

`DEFAULT true` is what makes adding them a one-statement migration. A row written before the columns
existed reads as "this may be a reference", so it is fetched and checked exactly as it was before —
no backfill, and no third state meaning "unknown". Postgres stores the default in the catalog, so
the `ALTER TABLE ... ADD COLUMN` does not rewrite the table.

### Design Rationale

This simplified table layout provides several advantages:

1. **Persistence Plugin Integration**: Each column stores schema-encoded assets that can be intercepted by persistence plugins (e.g., S3) before storage. When a plugin handles an asset, a `asset:retrievable:v1` reference is stored instead.

2. **Partial Non-GC Document Retrieval**: By storing non-garbage-collected documents (`nongcDoc`) at regular intervals with timestamps, we can query for recent non-GC states without loading years of history. This enables efficient retrieval of document versions with full edit history for recent changes only.

3. **Multiple Versions Per Document**: The composite primary key `(org, docid, branch, t)` allows storing multiple snapshots of each document over time, supporting:
   - Point-in-time recovery
   - Incremental compaction
   - Audit trails

4. **Selective Column Loading**: Queries can request only the columns needed (gc, nongc, contentmap, contentids), avoiding unnecessary data transfer.

### Table: `yhub_ydoc_tombstones_v1`

One record per deleted document — the durable answer to "is this document gone?". Redis cannot hold
that fact: the `ydoc:tombstone:v1` entry that notifies connected clients is trimmed away with the rest
of the stream within `minMessageLifetime`.

```sql
CREATE TABLE yhub_ydoc_tombstones_v1 (
    org         text,
    docid       text,
    branch      text,
    deleted_at  INT8    NOT NULL, -- unix ms (redis TIME), same clock domain as yhub_ydoc_v1.created
    hard        boolean NOT NULL, -- content erased immediately and irreversibly
    purged_at   INT8,             -- unix ms the content was actually erased; NULL while it still exists
    by          text,             -- authInfo.userid, NULL for internal deletions
    PRIMARY KEY (org, docid, branch)
);
CREATE INDEX yhub_ydoc_tombstones_v1_pending
    ON yhub_ydoc_tombstones_v1 (deleted_at) WHERE purged_at IS NULL;
```

Keyed by DocRef, like everything else — deletion is per branch. The partial index serves the only
non-key query shape there is, a retention task asking what still needs purging, and so stays
proportional to pending deletions rather than to every deletion ever.

`hard` is what the compact worker branches on. The barrier lives in `Persistence.store`'s `INSERT`
itself (`WHERE NOT EXISTS (.. AND d.hard)`), not in a check ahead of it: a compact task spends
seconds to minutes merging between reading a document's state and storing it, and `ON CONFLICT` cannot
catch a late write either, because `t` is a fresh clock on every compaction. Guarding inside the
statement also covers `unsafePersistDoc`, which reaches storage directly. Soft deletions are
deliberately unguarded, so compaction keeps persisting what is already on the stream.

`purged_at` is set only once the erase actually succeeded, which is what makes a crashed purge
resumable and the purge safe to re-run.

### Schema creation

Both tables are created by `bin/init-db.js` (`npm run start:init`), which is the only thing in
y/hub that runs DDL. This is a **manual step**, at setup and again when upgrading to a release that
introduces a table — servers and workers never create tables, so they need no permission to, and a
schema change happens at a moment the operator picked rather than implicitly during a rolling
deploy. Any release that adds a table says so in the changelog.

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
  docRef: {
    org: string,
    docid: string,
    branch: string
  },
  redisClock: string   // Redis stream message ID for correlation
}
```

### Task Lifecycle

1. **Creation**: When a new message arrives for a document with no existing stream, a `compact` task is added to the worker queue
2. **Debounce**: Tasks have a configurable delay (default: 10 seconds) before being claimed, allowing message batching
3. **Processing**: Worker claims task, compacts document, persists to PostgreSQL
4. **Completion**: Task removed, Redis stream trimmed
5. **Continuation**: If messages remain after trim, a new task is re-queued

The creation step relies on `EXISTS(liveStream) == 0` as the signal to enqueue, which means there is at most one pending task per live document at any time. Operations that remove the live key (notably `Stream.quarantine`) must leave a NOP entry behind so this invariant is preserved across the operation.

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

### Tombstone Message (`ydoc:tombstone:v1`)

```javascript
{
  type: 'ydoc:tombstone:v1'   // no payload
}
```

Notifies connected clients that the document was deleted; they are disconnected with close code `4404`.
Payload-free on purpose: clients are kicked identically for hard and soft deletions, and anything
that needs the distinction reads `yhub_ydoc_tombstones_v1`. That also makes it replay-idempotent, so
unlike `auth:check:v1` it survives `unquarantine` re-injection without a special case.

This is a *notification*, never the record — it is trimmed away like any other entry. A hard
deletion clears the stream with `XTRIM MAXLEN 0` rather than `DEL` before adding it: `DEL` would
reset the stream's `last_id`, so the notice could be assigned an id sorting *below* the clock a
subscriber already passed within the same millisecond, and the clients that were writing just now
— the ones that most need to hear it — would never see it. `DEL` would also flip `EXISTS` to 0 and
let the next write enqueue a second compact task beside the pending one, the same invariant the
[quarantine](#quarantine) NOP protects.

### Stream Storage Format

- **Document Streams**: `{prefix}:room:{org}:{docid}:{branch}` (URL-encoded components; the `room` in the key spelling deliberately predates the DocRef rename)
- **Quarantined Document Streams**: `{prefix}:quarantine_room:{org}:{docid}:{branch}:{qid}` (see [Quarantine](#quarantine))
- **Message Field**: Each message stored with field `m` containing the encoded buffer. Entries whose field is something other than `m` are skipped by every read path (used for NOP markers — see [Quarantine](#quarantine)).
- **Clock Format**: `"{timestamp}-{sequence}"` (e.g., `"1704067200000-5"`)

### Message Lifecycle

1. Messages added to document streams via `XADD`
2. Subscribers receive messages via `XREAD` with blocking
3. Messages retained for minimum lifetime (default: 1 minute)
4. Trimmed during compaction based on age

### Quarantine

Operational recovery path for documents whose updates repeatedly fail to compact. Exposed on the `Stream` instance as `quarantine(docRef)`, `getQuarantineStreams(docRef)`, `getAllQuarantineStreams()`, and `unquarantine(docRef, qid)`.

- **Quarantine key**: `{prefix}:quarantine_room:{org}:{docid}:{branch}:{qid}`. One key per quarantined snapshot; `qid` is a fresh UUID, so repeated quarantines on the same document accumulate rather than overwrite.
- **Invariant preserved**: the compact worker queue holds at most one pending task per live document. `quarantine` atomically renames the live stream to a quarantine key and inserts a NOP entry (field `nop`, not `m`) into the now-empty live key. The NOP keeps `EXISTS(live) == 1`, so a subsequent `addMessage` does not enqueue a second compact task alongside the pre-quarantine one. Without the NOP, two tasks for the same document would race the worker into duplicate `persistence.store` calls at the same `lastClock`.
- **Quarantined streams are read-only by convention**: nothing in the system writes to `quarantine_room:*` keys. `unquarantine` relies on this when it XRANGEs the contents and then DELs the key in a follow-up write — concurrent writers would silently lose data.
- **NOP entries** are ignored by the normal read path (`getMessages` filters on `message.m != null`) and trimmed by the usual `XTRIM MINID` when they age past `minMessageLifetime`.

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

  // Delete an asset that is no longer referenced - a superseded version during compaction, or
  // every version of a document during `purgeDoc`. Both reach it through
  // `Persistence.deleteReferences`, which drops the referencing row first, so a deletion that is
  // deferred or lost leaks an orphaned object rather than leaving a row pointing at nothing.
  delete?(assetId: AssetId, assetInfo: Asset): Promise<boolean>;
}
```

### Built-in: S3 Persistence

The `S3PersistenceV1` plugin offloads assets to S3:

- **Storage Path**: Uses asset ID string as S3 object key
- **Branch Filter**: Only stores assets from `main` branch by default
- **Returns**: `{ type: 'asset:retrievable:v1', plugin: 'S3Persistence:v1' }`

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
