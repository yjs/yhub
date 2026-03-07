# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

y/hub (`@y/hub`) is a scalable WebSocket backend for Yjs collaborative editing. It uses Redis for real-time update distribution and supports PostgreSQL + S3 for persistent storage. Licensed AGPL-3.0 or proprietary.

## Commands

### Lint
```bash
npm run lint           # standard + tsc --skipLibCheck
```

### Running Locally
```bash
npm run start:dbs      # Start Redis (Valkey), PostgreSQL, MinIO via Docker Compose
npm run start:init     # Initialize DB tables and S3 buckets
npm run start          # Start all services (server + worker + DBs) via Docker Compose
```

Server and worker can also be run individually:
```bash
node --env-file .env ./bin/server.js
node --env-file .env ./bin/worker.js
```

### Testing
Requires running databases (Redis, PostgreSQL, MinIO) and a `.env` file with connection details. Optional `.env.testing` overrides are loaded automatically if present.

```bash
npm test               # Run all tests
```

Tests use `lib0/testing` (not Jest/Mocha). The test runner is `tests/index.js` which imports all test modules. There is no built-in way to run a single test file — all suites run together. To debug:

```bash
npm run debug:test     # Tests with --inspect-brk
```

Environment variables needed for tests: `REDIS`, `POSTGRES`, `S3_ENDPOINT`, `S3_PORT`, `S3_SSL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_YHUB_TEST_BUCKET`. See `.env.template`.

## Architecture

### Components
- **Server** (`src/server.js`, `bin/server.js`) — uWebSockets.js WebSocket server. Accepts client connections, streams updates through Redis, serves initial sync by merging persisted + cached data. Stateless after initial sync.
- **Worker** (`src/index.js:YHub.startWorker`, `bin/worker.js`) — Background process that reads pending updates from Redis, merges them, persists to S3/PostgreSQL, and trims Redis streams. Uses Redis consumer groups for coordination.
- **Stream** (`src/stream.js`) — Redis abstraction. Manages Redis streams for rooms (`{prefix}:room:{org}:{docid}:{branch}`), pub/sub, worker task queues.
- **Persistence** (`src/persistence.js`) — PostgreSQL layer. Stores metadata (state vectors, content maps, S3 references) in `yhub_ydoc_v1` table.
- **Compute Pool** (`src/compute.js`, `src/compute-worker.js`) — Worker thread pool for CPU-intensive Yjs operations (merging updates, garbage collection, changesets).
- **Plugins** (`src/plugins/`) — Pluggable storage backends. Currently only `s3.js` (S3PersistenceV1).

### Key entry points
- `src/index.js` — Main module. Exports `YHub` class and `createYHub()` factory.
- `src/types.js` — Type definitions and schema validators using `lib0/schema`.
- `src/protocol.js` — Binary WebSocket protocol encoding/decoding.
- `bin/yhub.js` — CLI entry point that starts both server and worker.

### Code Style
- **Minimalistic and correctness-focused.** Keep code short, direct, and free of unnecessary abstractions. Don't add defensive code, extra error handling, or validation beyond what is needed. Prefer simple, correct implementations over clever or verbose ones.
- Pure JavaScript with JSDoc type annotations (no .ts files). TypeScript is used only for declaration generation (`emitDeclarationOnly`).
- Linted with [standard](https://standardjs.com/) (no semicolons, 2-space indent).
- ESM (`"type": "module"`) throughout. Node >= 22 required.
- Heavy use of `lib0` utilities (encoding, decoding, logging, promises, schemas).
- Schemas defined with `lib0/schema` (`s.$object`, `s.$union`, `s.$literal`, etc.) for runtime validation.

### Data Flow
1. Client connects via WebSocket → server authenticates via auth plugin callback
2. Server sends initial sync (merged from PostgreSQL/S3 + Redis cache)
3. Client updates flow: Client → Server → Redis stream → all subscribed servers → other clients
4. Worker picks up tasks from Redis worker queue → merges updates → stores in S3 → updates PostgreSQL metadata → trims Redis
