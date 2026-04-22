# Changelog

## [Unreleased]

## [0.2.17] - 2026-04-22

### New Features

- **Stream quarantine API.** Three new methods on `Stream` for operationally isolating a room whose updates repeatedly fail to compact, without taking the room offline:
  - `stream.quarantine(room)` — atomically renames the live Redis stream to `{prefix}:quarantine_room:{org}:{docid}:{branch}:{qid}` and inserts a NOP entry into the (now empty) live key. The NOP uses a non-`m` field so every read path ignores it; its purpose is to keep the live key non-empty so a subsequent write doesn't enqueue a duplicate compact task alongside the pre-quarantine one. Returns the generated `qid`, or `null` if there is no live stream to quarantine.
  - `stream.getQuarantinedStreams(room)` — returns the list of qids currently parked for a room.
  - `stream.unquarantine(room, qid)` — re-injects every message from the quarantined stream back into the live stream via the standard `addMessage` path (re-enqueueing the compact task if the live stream had been drained) and deletes the quarantine key. Returns the number of messages re-injected. The read + re-inject + delete is batched in a single `MULTI/EXEC`; quarantined streams are read-only by convention, so nothing writes between the XRANGE and the DEL.

## [0.2.12] - 2026-03-18

### Breaking Changes

- **Switched to Pino logging.** All logging now uses [Pino](https://github.com/pinojs/pino) instead of `lib0/logging`. Log output is structured JSON by default; use `pino-pretty` for human-readable output during development. All npm scripts now pipe through `pino-pretty`.
- **`redis.tlsCaCert` replaced by `redis.socket`.** The `redis.tlsCaCert` config field has been replaced with a generic `redis.socket` object that is merged into the Redis client socket config. See [node-redis socket options](https://github.com/redis/node-redis/blob/master/docs/client-configuration.md#socket-options) for available options.
- **`decodeContentMaps` API change.** The `decodeContentMaps` function signature/return type has changed.

### Improvements

- **Bumped Yjs to rc.2.** Updated `@y/y` to `^14.0.0-rc.2` and `lib0` to `^1.0.0-rc.5`.
- **Better error handling in WebSocket open handler.** Errors during the WebSocket `open` callback are now caught and handled gracefully instead of crashing the connection.
- **Improved worker failure logging.** Worker failures now produce more detailed log output for easier debugging.
- **Reduce log verbosity.** Avoid logging large objects and binary data in stream and worker logs. Log counts and summaries instead.

### Bug Fixes

- **Fixed rollback.** Resolved a rollback bug introduced alongside the Yjs rc.2 upgrade.

## [0.2.10] - 2026-03-06

### New Features

- **Redis TLS support (`tlsCaCert`).** Added an optional `redis.tlsCaCert` config field that accepts a PEM-encoded CA certificate string for TLS connections (`rediss://`).

### Performance

- **Compute worker thread pool.** All CPU-intensive Yjs operations (merge, rollback, changeset, activity, patch) are now offloaded to a pool of worker threads, keeping the main event loop free for I/O. Workers are created lazily up to `maxPoolSize` (defaults to `cpus - 1`). Stale workers running longer than 30 minutes are automatically terminated and replaced. Dead workers (e.g. from uncaught exceptions) are detected and recycled.
- **Smart `mergeUpdates`.** Small merges (≤ 5kb or single update) run synchronously to avoid worker overhead; larger merges are offloaded to a worker thread.

### Bug Fixes & Reliability

- **Fix `unsafePersistDoc` attribute names.** Content attribute names (`insert`/`insertAt`/`delete`/`deleteAt`) were incorrect. (Thanks @PabloSzx — #43)
- **Catch all floating promises.** Added `.catch()` handlers to previously unawaited promises in the Redis stream, S3 persistence, worker startup, and HTTP request handlers, preventing silent failures.
- **Fix worker hang on `--inspect`.** Worker threads no longer inherit `--inspect` flags from the parent process, which caused them to fail when binding to the same debugger port.
- **Fix dead worker recovery.** Workers that crash from uncaught exceptions are now correctly marked as dead before draining the task queue, preventing tasks from being sent to terminated threads.

### New Features

- **Activity API: `contentIds` filter.** Pass a base64-encoded `Y.ContentIds` to restrict activity results to changes that touch a specific set of Yjs content (e.g. a single YType attribute). Encode via `buffer.toBase64(Y.encodeContentIds(ids))`.

## [0.2.8] - 2026-02-27

- **`yhub.unsafePersistDoc`** — new import-API method to write and attribute a Yjs update directly to the database without going through Redis/WebSocket. Useful for server-side migration scripts.
- **S3 reliability fixes** — keepalive connections, automatic retry on transient failures, and graceful handling of nonexistent resources.
- **Rollback API** now uses the standard undo/redo model for KV (map) entries, matching the behaviour users expect from collaborative editors.
- **Faster update merging** — bumped `@y/y` dependency for more efficient Yjs update merging.

## [0.2.7] - 2026-02-23

- Fixed a remaining infinite-recursion crash in the activity API under certain document shapes.

## [0.2.6] - 2026-02-20

- **S3 multipart uploads** — large documents are now uploaded to S3 in parallel chunks, avoiding timeouts and memory pressure on the server.
- Fixed infinite recursion in the activity API when `delta=true` was requested on certain documents.

## [0.2.5] - 2026-02-17

- **KeyDB support** — KeyDB can now be used as a drop-in Redis alternative.
- **Activity API: `customAttributions` response field** — passing `customAttributions=true` now returns the list of custom attribution key-value pairs associated with each activity entry (deduplicated when grouping is enabled).

## [0.2.4] - 2026-02-17

- **Activity & WebSocket: filter by custom attributions** — the `/activity` endpoint and the WebSocket connection both now accept a `withCustomAttributions` query parameter (`key:value` pairs) to limit results to changes that carry matching attributions.

## [0.2.3] - 2026-02-16

This release focused on **performance** and the new **custom attributions** feature. Y/hub now avoids loading YDocs into memory during sync, making it possible to handle very large documents (300MB+) and thousands of concurrent WebSocket connections without breaking a sweat. REST API responses are now cached via Redis for efficient repeated access.

### Performance

- **Documents are never loaded into memory during sync.** Both WebSocket and REST endpoints now operate directly on binary-encoded updates, avoiding costly YDoc instantiation on every request. This drastically reduces memory usage and CPU overhead. ([`src/server.js`](src/server.js), [`src/index.js`](src/index.js))
- **Support for very large documents (300MB+).** Syncing huge Yjs documents works reliably for both WebSocket and REST clients.
- **Thousands of concurrent WebSocket connections.** Improved connection handling and error recovery allow the server to sustain high connection counts without degradation.
- **Smart caching for REST API responses.** The `/changeset` and `/activity` endpoints cache computed results in Redis. Cache TTL adapts to computation time: `cacheTtl + computeTime * 2`. Configurable via [`redis.cacheTtl`](src/types.js) (default: 5 seconds). ([`src/stream.js`](src/stream.js))
- **Optimized WebSocket initial sync.** The server now sends `syncStep1` after retrieving the document, improving sync reliability and reducing round-trips. The WebSocket provider timeout has been increased accordingly.

### Custom Attributions

Custom key-value attributions can now be attached to changes and used to filter rollbacks and changesets. See the [API documentation](API.md) for full details.

- **PATCH /ydoc** - Accepts an optional `customAttributions` field (`Array<{ k: string, v: string }>`) in the request body. Custom attributions are stored alongside standard attributions as `insert:<key>` / `delete:<key>` attributes. ([API docs](API.md#patch-ydocorgdocid), [`src/server.js`](src/server.js))
- **POST /rollback** - Two new optional body fields:
  - `customAttributions` - attach custom attributions to the rollback (undo) changes themselves.
  - `withCustomAttributions` - filter which changes to undo by matching custom attribution key-value pairs. ([API docs](API.md#rollback), [`src/server.js`](src/server.js))
- **GET /changeset** - New `withCustomAttributions` query parameter using `key:value,key:value` format to filter changesets by custom attributions. ([API docs](API.md#changeset), [`src/server.js`](src/server.js))
- **Rollback safety.** The rollback endpoint now returns a `400` error when called without any filter (`from`, `to`, `by`, `contentIds`, or `withCustomAttributions`), preventing accidental full-document reverts.

### Bug Fixes & Reliability

- **Fixed S3 persistence race condition** when handling concurrent file transfers. ([`src/plugins/s3.js`](src/plugins/s3.js))
- **Fixed task cleanup ordering** in the worker by sorting redis clock values correctly before determining the last persisted clock. ([`src/persistence.js`](src/persistence.js))
- **Improved WebSocket error handling.** Client message processing is now wrapped in try/catch, and connections are properly cleaned up on errors. ([`src/server.js`](src/server.js))
- **Handle unacknowledged worker tasks.** Ghost tasks in the Redis worker stream are now detected and cleaned up automatically. ([`src/stream.js`](src/stream.js))

### Dependencies

- Bumped `redis` client to `^5.10.0`.
- Bumped `@y/protocols` to `^1.0.6-3`.
