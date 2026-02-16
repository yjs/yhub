# Changelog

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
