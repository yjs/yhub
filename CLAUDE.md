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
npm run start          # Provision the dev environment, then run server + worker
npm run dev:up         # Only provision: allocate ports, write .env, start the dbs, init them
npm run dev:down       # Stop the dev containers (keeps the data volumes)
npm run dev:release    # Stop, drop the volumes, and release the port block
```

Server and worker can also be run individually:
```bash
npm run start:server
npm run start:worker
```

**Every worktree gets its own dev environment.** `scripts/dev-env.js` derives a block of 16
host ports from a hash of the worktree path (range 4416-4927, claimed in
`~/.cache/yhub/dev-ports/`), writes them into the managed section at the bottom of `.env`, and
starts a compose project named after the worktree. Several worktrees can therefore run their
databases and test suites at the same time without sharing anything. Anything you write
*above* the managed marker in `.env` is preserved.

### Testing
`npm test` provisions the dev environment first (via the `pretest` hook), so no manual setup is
needed. Tests run against `POSTGRES_TESTING` and `S3_YHUB_TEST_BUCKET` on ports derived from
`TEST_PORT`, so they never touch your dev data.

The tables must already exist. `npm run dev:up` (which `pretest` calls) runs `bin/init-db.js`,
so a release that adds a table is picked up automatically on the next run. Nothing creates them
implicitly: not the test harness, not the server, not the worker.

```bash
npm test               # Run all tests
npm test -- --filter "\[12/"   # Re-run a single test
```

Two test runs *within the same worktree* still share a redis prefix and postgres table and must
stay serial. Across worktrees they are fully independent.

Tests use `lib0/testing` (not Jest/Mocha). The test runner is `tests/index.js` which imports all test modules. There is no built-in way to run a single test file — all suites run together. To debug:

```bash
npm run debug:test     # Tests with --inspect-brk
```

Environment variables needed for tests: `REDIS`, `POSTGRES`, `S3_ENDPOINT`, `S3_PORT`, `S3_SSL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_YHUB_TEST_BUCKET`. See `.env.template`.

**When writing or running tests, use the `lib0-testing` skill** for guidance on the `lib0/testing` and `lib0/prng` APIs, test structure, fuzz/property-based testing patterns, and runner setup.

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
- ESM (`"type": "module"`) throughout. Node 22, 24, or 26 required (uws ships binaries for exactly these).
- Heavy use of `lib0` utilities (encoding, decoding, logging, promises, schemas).
- Schemas defined with `lib0/schema` (`s.$object`, `s.$union`, `s.$literal`, etc.) for runtime validation.

### Data Flow
1. Client connects via WebSocket → server authenticates via auth plugin callback
2. Server sends initial sync (merged from PostgreSQL/S3 + Redis cache)
3. Client updates flow: Client → Server → Redis stream → all subscribed servers → other clients
4. Worker picks up tasks from Redis worker queue → merges updates → stores in S3 → updates PostgreSQL metadata → trims Redis
