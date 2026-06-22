# Changelog

## [0.2.25] - 2026-06-22

### New Features

- **History pruning API.** `POST /prune/{org}/{docid}` and the import-API method `yhub.pruneDoc(room, filters)` permanently compact *churned* history — content that was both inserted **and** deleted within a filtered range. Filters mirror `/rollback` (`from`/`to` unix timestamps, `by`, `contentIds`, `withCustomAttributions`); only content whose insertion *and* deletion both fall in the range is pruned. The matched content is garbage-collected from the non-GC document and removed from the contentmap, so it no longer appears in the [activity](API.md#activity) or [changeset](API.md#changeset) APIs and no longer occupies storage — while live content (inserted but never deleted) and the current visible document state are untouched. Pruning the span between two activity entries effectively *merges* them; pass `{ from: 0, to: Number.MAX_SAFE_INTEGER }` to compact a document's entire history. **Irreversible:** the prune is distributed as a `prune:v1` directive on the Redis stream and baked into persistence on the next compaction (store-before-trim, so there is no lossy window). Internally adds a `computePruneSet` compute task (the strict intersection — `Y.intersectSets` — of the in-range insertions and deletions) and threads an optional serialized `IdSet` through `mergeUpdates` to drive `Y.gcIdSet`. ([API docs](API.md#prune), [`src/server.js`](src/server.js), [`src/index.js`](src/index.js), [`src/compute.js`](src/compute.js), [`src/compute-worker.js`](src/compute-worker.js), [`src/y-utils.js`](src/y-utils.js), [`src/types.js`](src/types.js))

### Bug Fixes

- **`stream.getMessages` debug logging no longer assumes every message carries an `update`.** The retrieval debug log read `m.update.byteLength` for every message; the new `prune:v1` directive has no `update`, so this would throw whenever debug logging was enabled and a prune directive was on the stream. The log now narrows by message type. ([`src/stream.js`](src/stream.js))

### Internal

- **Migrated to `@y/y`'s Renderer API** (now `^14.0.0-rc.20`). The attribution-manager constructors were replaced by renderers: changeset/activity delta rendering uses `Y.createDiffRenderer(prevDoc, nextDoc, { attrs })` consumed via `toDelta({ renderer })` / `toDeltaDeep({ renderer })` (previously `Y.createAttributionManagerFromDiff` passed positionally), and `Y.TwosetRenderer` replaces `Y.TwosetAttributionManager`. The rollback undo option `ignoreRemoteMapChanges` was renamed to `ignoreRemoteAttributeChanges`. ([`src/compute-worker.js`](src/compute-worker.js))

## [0.2.22] - 2026-06-05

### New Features

- **Per-room compaction disable API.** Three new methods on `Stream` for operationally freezing a room's Redis stream (e.g. for inspection or maintenance) without taking the room offline:
  - `stream.disableCompaction(room)` — atomically removes the room's pending compact task from the worker queue and adds the room to the `{prefix}:compaction_disabled` set. While disabled, workers never pick up the room and writes don't enqueue new compact tasks (the `addMessage` script checks the set), so the room's stream is neither persisted nor trimmed; live update distribution to connected clients is unaffected.
  - `stream.enableCompaction(room)` — removes the room from the disabled set and re-enqueues a compact task if the room's stream exists. No-op for rooms that aren't disabled.
  - `stream.getDisabledCompactionRooms()` — lists all rooms with disabled compaction.

  ([`src/stream.js`](src/stream.js))
- **`redis.clientOptions` config.** Additional options passed through to the node-redis client, e.g. `{ pingInterval: 10000 }` for keepalive PINGs. y/hub still controls `url`; `redis.socket` is merged into the final socket config; `clientOptions.scripts` are merged with y/hub's Lua scripts. ([API docs](API.md#configuration), [`src/stream.js`](src/stream.js), [`src/types.js`](src/types.js))

### Bug Fixes

- **A late-completing worker can no longer spawn a duplicate compact-task chain.** When a worker runs longer than `taskDebounce`, its compact task is reclaimed by another worker; both eventually finish and call `trimMessages` with the same task id. The XACK guard already prevented a duplicate *re-enqueue*, but the stream trim and the delete-when-empty ran unconditionally — so the late worker could DEL the room stream key while the reclaiming worker's successor task was still pending, and the next write (`EXISTS == 0`) would enqueue a second compact task. The result was two concurrent task chains for the same room: redundant compactions and recurring duplicate-key errors on persist (the hazard described in the `quarantine()` comment). `trimMessages` now gates all stream mutations (trim, delete, successor re-enqueue) on winning the XACK; a late completion is a pure no-op. ([`src/stream.js`](src/stream.js))

## [0.2.21] - 2026-06-03

### New Features

- **Experimental native merge via yrs (`@y-crdt/yn`).** y/hub can optionally delegate `mergeUpdates` to [y-crdt/yn](https://github.com/y-crdt/yn) — a thin Node.js binding over [yrs](https://github.com/y-crdt/y-crdt), the Rust port of Yjs — instead of running it in JavaScript. **Off by default and not production-ready**; intended for benchmarking the merge hot path. Enable with `USE_Y_NATIVE=1` (or `--use-y-native`), read via `lib0/environment.hasConf`. Server and worker evaluate the flag independently. Only the three `Y.mergeUpdates` call sites are affected — the inline fast path ([`src/compute.js`](src/compute.js)), the worker-thread merge task ([`src/compute-worker.js`](src/compute-worker.js)), and the WebSocket sync fan-out ([`src/server.js`](src/server.js)); everything else (sync protocol, attribution metadata, delta/changeset computation, awareness, snapshots, undo) continues to run on `@y/y`. When the flag is off, behavior is unchanged. Caveats: `@y-crdt/yn` exposes only `applyUpdates(gc, updates)` (no v2 update encoding), and protocol compatibility between yrs and `@y/y` 14's attribution-laden updates is **not verified**. See the [README](README.md#experimental-native-merge-via-yrs-y-crdtyn) for details. ([`src/y-utils.js`](src/y-utils.js))

### Internal

- **Consolidated `mergeUpdates` and `mergeUpdatesAndGc`.** The compute pool's two merge entry points are now a single `mergeUpdates(gc, updates, logContext)` where `gc` selects whether deleted content is garbage-collected. The shared merge implementation lives in [`src/y-utils.js`](src/y-utils.js) and is used by both the main thread and the worker pool, so the native/JS switch applies uniformly. ([`src/compute.js`](src/compute.js), [`src/compute-worker.js`](src/compute-worker.js))

## [0.2.19] - 2026-04-22

### New Features

- **`yhub.agentTask(room, opts, handler)`** — new import-API method for running LLM agent tasks against a room. The handler receives a freshly hydrated `Y.Doc` (gc'd snapshot of the room's current state) and an `Awareness` instance bound to it; edits to either are streamed live to all connected clients with attribution. Options: `author` (user-id, mapped to `insert`/`delete` content attributes), `displayedAuthor` (awareness `user.name`, defaults to `author`, never recorded in the contentmap), `promptBy` (sugar for `customAttributions: [{ k: 'promptBy', v: promptBy }]`), `customAttributions` (full `Array<{ k, v }>` matching the WS/REST shape), and `clearAwareness` (seconds — `0` = clear immediately on exit, `false` = leave in place; errors always clear immediately). The returned promise resolves only after the awareness disconnect has been broadcast. Errors from the handler or from stream forwarding are surfaced to the caller. ([`src/agents.js`](src/agents.js), [API docs](API.md#yhubagenttaskroom-opts-handler))
- **`PATCH /ydoc/{org}/{docid}` awareness support.** Body shape is now `{ update?, awareness?, customAttributions? }` with both `update` and `awareness` optional (at least one required). `awareness` carries bare `encodeAwarenessUpdate(...)` bytes — the same format the WS path puts on the stream — and is distributed to all connected clients through the same Redis channel. `customAttributions` only applies to `update`. ([API docs](API.md#patch-ydocorgdocid), [`src/server.js`](src/server.js))
- **`GET /ydoc/{org}/{docid}?awareness=true`.** Returns `{ doc, awareness? }` with `awareness` as the merged room awareness in bare-bytes format — round-trippable through PATCH and directly consumable by `applyAwarenessUpdate`. Omitted when the room has no awareness state. Default response shape (no flag) is unchanged. ([API docs](API.md#get-ydocorgdocid), [`src/server.js`](src/server.js))

### Bug Fixes

- **Strip phantom local client in `mergeAwarenessUpdates`.** The y-protocols `Awareness` constructor seeds its own `clientID` via `setLocalState({})`, which leaked as a phantom empty-state client to every consumer of the merged bytes (WS initial sync, GET `/ydoc?awareness=true`). The merger now removes its own clientID before encoding, so the `byteLength > 3` "empty awareness" check on the WS initial-sync path is now actually correct. ([`src/protocol.js`](src/protocol.js))

## [0.2.18] - 2026-04-22

### New Features

- **Stream quarantine API.** Three new methods on `Stream` for operationally isolating a room whose updates repeatedly fail to compact, without taking the room offline:
  - `stream.quarantine(room)` — atomically renames the live Redis stream to `{prefix}:quarantine_room:{org}:{docid}:{branch}:{qid}` and inserts a NOP entry into the (now empty) live key. The NOP uses a non-`m` field so every read path ignores it; its purpose is to keep the live key non-empty so a subsequent write doesn't enqueue a duplicate compact task alongside the pre-quarantine one. Returns the generated `qid`, or `null` if there is no live stream to quarantine.
  - `stream.getQuarantineStreams(room)` — returns the list of qids currently parked for a room. `stream.getAllQuarantineStreams()` returns `{room, qid}` pairs across every room.
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
