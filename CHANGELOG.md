# Changelog

## [0.9.0]

### Breaking Changes

- **`S3PersistenceV1` offloads every branch by default.** Previously only `main` was offloaded and
  other branches stored their assets inline in postgres. The new `branches` option controls it:
  `true` (the new default) offloads every branch, an array offloads only the listed ones —
  `branches: ['main']` restores the previous behavior. No migration is needed: the reference
  markers are per asset, existing inline rows stay valid, and the next compaction of a branch
  offloads its new version. ([README](README.md#s3-persistence-s3persistencev1))

## [0.8.2]

### New Features

- **`GET /activity?groupExclude=agent-1,agent-2`** — exempt the listed userids from grouping: their consecutive edits stay individual activity entries while other users group as usual. ([API docs](API.md#activity))

## [0.8.1]

### Fixes

- **`PATCH /ydoc` no longer answers `403` for an `awareness` field the caller may not broadcast.** Presence without awareness `u` is dropped silently, as it is on the websocket; the `update` field still requires ydoc `u` and a refused update writes nothing. An awareness-only body without the permission answers `200` with nothing written. ([API docs](API.md#patch-apiydocv1orgdocid))

### Other

- Docs: the `c` and `d` positions of the `ydoc` and `awareness` masks are reserved and currently grant nothing — `'crud'` and `'-ru-'` are equivalent grants for now. ([API docs](API.md#permissions))

## [0.8.0]

> **Upgrading:** the auth plugin interface changed. Rewrite `server.auth` from
> `{ readAuthInfo, getAccessType }` to `{ authenticate, authorize }` (migration table below), and in
> custom endpoints replace `scope: 'doc'` with `'document'`, `req.room` with `req.docRef`,
> `req.accessType` with `req.permissions`, and drop `accessPurpose`.

### Breaking Changes

- **Permissions replace `AccessType`.** The auth plugin no longer answers `'r' | 'rw' | null`; it answers a typed permission object that states exactly what a subject may do with a document, and yhub enforces every part of it, on REST and on the websocket alike:

  ```js
  auth: createAuthPlugin({
    // who is asking - or null for an anonymous caller (reject a bad credential with apiError(401, ..))
    authenticate: async req => ({ userid: await verifyToken(req) }),
    // what they may do - one handler per scope, scopes without a handler deny
    authorize: createAuthorize({
      document: async ({ org, docid, branch }, user) => ({
        type: 'permissions:document:v1',
        ydoc: 'cru-',              // crud mask: r = read/sync, u = write (c and d are reserved, they do nothing yet)
        awareness: '-ru-',         // r = receive presence, u = broadcast it (c and d reserved as well)
        history: { from: 0, rollback: true, prune: false }, // attributed history from `from` (unix ms, 0 = all)
        delete: ['soft'],          // allowed forms of DELETE /ydoc: 'soft' and/or 'hard'
        endpoint: { '*': 'crud' }  // rest routes by name ('*' = fallback), by verb: get→r, post→c, put/patch→u, delete→d
      })
    })
  })
  ```

  What this changes for you:
  - **Destructive rights are granted by name.** `rollback`, `prune` and `delete` are no longer implied by write access. `DELETE /ydoc?hard=true` becomes possible over REST once `'hard'` is granted (it was programmatic-only).
  - **Every REST endpoint is gated by the `endpoint` facet** - builtin and custom, before the handler runs. The websocket is the endpoint named `ws` (`r` opens it, `u` allows sending updates). A grant without any `endpoint` entry opens nothing; `endpoint: { '*': 'crud' }` is the "everything" spelling.
  - **History is a ray.** `changeset`/`activity` only show history from `history.from` on (the query's `from` is clamped up to it), `?ydoc=`/`?delta=` additionally need ydoc `r`, and `gc=false` needs `from: 0`. Rollback and prune requests reaching before the ray are refused with `403`, never clamped. `from`/`to` must be non-negative integers (`400` otherwise).
  - **Anonymous callers exist.** `authenticate` returning `null` means "nobody", and `authorize` is still asked (public documents). yhub never answers `401` for a *missing* credential, with one exception: writing the document needs an identity because attributions carry the userid - `401 { code: 'unauthenticated' }` on `PATCH /ydoc`, `POST /rollback` and the websocket upgrade.
  - **Read-only connections can broadcast presence** when granted awareness `u` (their cursors used to be dropped).
  - **Denial is a value, a throw is an outage.** Return `null` to deny. A throw from either hook answers `503` (websocket re-check: close `1013`); a branded `apiError(status, ..)` passes through. An invalid or wrong-scope answer is a logged `500`, never a silent denial.
  - **`403` bodies name what is missing:** `{ error, code: 'missing-permission', required }`, where `required` is the permission object the request needed.
  - **Custom endpoints:** `req.permissions` (the normalized view, or `null`) replaces `req.accessType`; a handler checks the facets it touches with `checkPermissions(req.permissions, createDocumentPermissions({ ydoc: '-r--' }))`. `accessPurpose` is gone, and the built-in names (`ydoc`, `rollback`, `prune`, `changeset`, `activity`, `ws`) can no longer be reused by custom endpoints in any version.

  Migrating from `AccessType`: `'rw'` → `{ type: 'permissions:document:v1', ydoc: 'cru-', awareness: '-ru-', history: { from: 0 }, endpoint: { '*': 'crud' } }`; `'r'` → the same with `ydoc: '-r--'` and `endpoint: { '*': '-r--' }`; `null` → `null`. Org/global scopes: `{ type: 'permissions:org:v1', endpoint: { '*': 'crud' } }` (`'-r--'` for `'r'`). Add `rollback`, `prune` and `delete` deliberately. ([API docs](API.md#permissions), [migration](API.md#migrating-from-accesstype), [design](proposals/permissions.md))

- **`Room` is now `DocRef`.** The `{ org, docid, branch }` triple is a `DocRef` throughout the API: `Room` → `DocRef`, `$room` → `$docRef`, `req.room` → `req.docRef`, `DocDeletedError.room` → `.docRef`, worker event payloads' `room` → `docRef`. Routes, query params, SQL columns and redis key spellings are unchanged. ([naming](proposals/naming.md))
- **`demos/` and `bin/auth-server-example.js` are removed**, together with the unused `AUTH_PUBLIC_KEY`/`AUTH_PRIVATE_KEY` entries in `.env.template`. They showed a y-redis-era external-auth flow that yhub never calls; auth examples live in [GETTING-STARTED.md](GETTING-STARTED.md).

### New Features

- **`@y/hub/permissions`** - the permission toolkit for plugins: the creators (`createDocumentPermissions`, `createOrgPermissions`, ..), `documentPermissionsUnion` / `documentPermissionsIntersect` to compose grants (union several role grants, intersect to attenuate a token), `sanitizePermissions` for objects read from tokens or HTTP, `hasPermissions(granted, required)`, and the schemas. `createAuthorize`, `checkPermissions` and the creators are also exported from `@y/hub`.

### Fixes

- **Prune drops cached `changeset`/`activity` responses**, so pruned content no longer lingers in the cache until it expires.

## [0.7.0]

### Breaking Changes

- **Cross-origin browser access is closed by default.** The hardcoded `Access-Control-Allow-Origin: *` is gone: API requests and websocket upgrades from a foreign `Origin` are rejected with `403 { code: 'origin-not-allowed' }` unless `server.cors` allows them. Same-origin pages and non-browser clients keep working without configuration (same-origin is detected via `Sec-Fetch-Site` when the browser sends it, else a scheme-blind `Origin`/`Host` comparison, so TLS-terminating proxies are fine). ([API docs](API.md#cors))

### New Features

- **`server.cors`** (`CORS_ORIGIN` for the CLI / docker image) configures cross-origin access: `origin` (`'*'`, one origin, or an allowlist with `https://*.example.com` wildcards), `credentials`, `allowHeaders`, `exposeHeaders`, `maxAge`, `trustSameOrigin`. Misconfigurations (`'*'` with `credentials`, a bare `'*'` in `allowHeaders`, ..) fail at startup; `'*'` restores the old wide-open behavior and logs a warning. A custom endpoint can override it with its own `cors` field (`null` disables CORS for that endpoint). ([API docs](API.md#cors))

### Other

- **uws v20.69.0, adding Node 26 support.** Supported Node versions are now exactly 22, 24 and 26 (`engines.node: ^22.9.0 || ^24.0.0 || ^26.0.0`); Node 25 is no longer supported.

## [0.6.0]

> **Upgrading: run `npm run start:init` (`bin/init-db.js`) before starting this version.** It adds
> the `yhub_ydoc_tombstones_v1` table. Servers and workers do not create tables themselves, so
> without this step the first deletion — and every read of a document, which checks for one —
> fails with `relation "yhub_ydoc_tombstones_v1" does not exist`. The script is idempotent.

### New Features

- **Document deletion.** `yhub.deleteDoc(room, { hard?, by? })` deletes a document, `DELETE /api/ydoc/v1/{org}/{docid}` exposes the soft form over REST, and `yhub.restoreDoc(room)` undoes it. Deletion is recorded in a new `yhub_ydoc_tombstones_v1` table and is **per branch**, keyed `(org, docid, branch)` like everything else — deleting a document with all of its branches means deleting each of them. ([API docs](API.md#yhubdeletedocroom-opts), [`src/index.js`](src/index.js), [`src/persistence.js`](src/persistence.js))
  - A **soft** deletion only records that the document is gone: reads report it as deleted and every endpoint answers 404, connected clients are disconnected, but its rows and S3 objects are untouched and **compaction keeps running**, so updates still sitting on the Redis stream are persisted rather than trimmed away unpersisted. `restoreDoc` brings it back with its full history.
  - A **hard** deletion clears the stream and erases every row and asset immediately, and cannot be undone. It is programmatic only: `purpose` is advisory, so irreversible erasure is not reachable over REST.
  - Compaction never persists a hard-deleted room again. The barrier is a `WHERE NOT EXISTS` clause *inside* `Persistence.store`'s `INSERT`, not a check ahead of it — a compact task spends seconds to minutes merging between reading a room's state and storing it, and `ON CONFLICT` cannot catch a late write either because `t` is a fresh clock on every compaction. Guarding inside the statement also covers `unsafePersistDoc`, which reaches storage directly.
  - `yhub.getDoc` reports a deletion as `tombstone` rather than refusing it; each caller decides. Every reading endpoint — `GET`/`PATCH /api/ydoc/v1`, `rollback`, `prune`, `changeset`, `activity` — throws `DocDeletedError` (exported from `@y/hub`), which answers `404 { code: 'doc-deleted' }`; the WebSocket path closes with `4404`; the compact worker carries on, because it still has to trim the stream. `Persistence.retrieveDoc` returns the tombstone in the same statement as its rows (a `FULL OUTER JOIN`), so knowing costs no extra round trip. Custom endpoints that read a document should check `tombstone` the same way.
  - Cached `changeset`/`activity` responses are dropped when a document is deleted. A cache hit never reaches `getDoc`, so without this a response cached moments earlier would keep being served for up to `cacheTtl`. Cache keys are now `{prefix}:cache:{org}:{docid}:{branch}:{endpoint}:{args}` — room first — so the invalidation is an exact prefix match rather than a convention about argument order. ([`src/stream.js`](src/stream.js))
  - WebSocket clients are disconnected with close code `4404` (`wsCloseDocDeleted`), a permanent code in the `4400`-`4499` band, distributed as a new payload-free `ydoc:tombstone:v1` stream message. Clients following the band rule stop reconnecting on their own; dropping the local copy still needs an app-level handler.
  - Writes to a deleted room are not rejected at the Redis layer; they simply never reach postgres for a hard-deleted room and are trimmed away with the rest of the stream.
  - No retention sweeper ships. A daily task sweeps `yhub.getTombstones(org, { purged, before })` and hard-deletes what is due — see [the retention recipe](API.md#retention). Erasing content is not a verb of its own: it is only safe once `hard` is set, which is what arms the `store` barrier against a compaction still in flight.
- **`Persistence.retrieveAssets(room, include, { onlyReferences })` lists every asset a document stores, unresolved.** `retrieveDoc` is now built on it — retrieve, resolve, group — and the purge erases through it and the existing `deleteReferences`, so compaction and deletion share one path and both drop a row before the asset it points at; an interrupted purge leaves an orphaned object, never a reference to a missing one. Listing straight from the columns is also what fixes a stranding bug: `retrieveDoc` used to report only references that still *resolved*, so a version whose object had vanished kept its row forever, invisible to both compaction and deletion. No new plugin hook — `delete` stays the only asset-deletion entry point. ([`src/persistence.js`](src/persistence.js), [`src/types.js`](src/types.js))
- **`yhub_ydoc_v1` records whether each asset column holds a reference or the bytes themselves** — `gcDoc_is_reference` and friends, `NOT NULL DEFAULT true`. `onlyReferences: true` then leaves inline blobs in postgres instead of reading them out to discard them, which is what a purge of a non-`main` branch used to do (`S3PersistenceV1` only offloads `main`, so other branches store their assets inline). Existing rows read as `true` — "may be a reference" — so they are fetched and checked exactly as before: no backfill, and the `ALTER` is metadata-only. **Re-run `npm run start:init`.** ([`src/persistence.js`](src/persistence.js), [`bin/init-db.js`](bin/init-db.js))
- **Per-method `accessPurpose` on api endpoints.** A method may override its endpoint's purpose (`delete: { accessPurpose: 'admin', handler }`), so a destructive method can be gated more tightly than the reads beside it — setting it on the endpoint would silently change the purpose every existing caller of the other methods is authorized against. The built-in `ydoc` endpoint uses it for `delete`. ([API docs](API.md#authorization-and-purpose), [`src/api.js`](src/api.js))
- **`bin/init-db.js` now creates every table y/hub needs.** It previously guarded all of its DDL on `yhub_ydoc_v1` being absent, so a table added in a later release would never have been created on an existing deployment. It remains the only thing in y/hub that runs DDL — servers, workers, and the test harness never create tables, so schema changes stay an explicit operator step. ([`bin/init-db.js`](bin/init-db.js))

### Bug Fixes

- **Security: the api response cache could serve one document's content for another.** `cachedGet` built its Redis key by joining raw arguments with `:`, and the first three are always `org`/`docid`/`branch` — so `org='a:b',docid='c'` and `org='a',docid='b:c'` produced a byte-identical key, and a `changeset`/`activity` response (including the full ydoc under `?ydoc=true`) could be served across that boundary. Arguments are now escaped. ([`src/stream.js`](src/stream.js))
- **A docid could match foreign rooms when listing quarantine streams.** `encodeURIComponent` leaves `*` unescaped, and `org`/`docid` come verbatim off the url, so a docid like `draft*` widened the Redis glob `getQuarantineStreams` builds. Redis key components are now percent-encoded with `uriEncode`, which escapes `*` along with the rest of `!'()` — every other glob metacharacter (`?`, `[`, `]`, `\`, `^`) was already escaped — so no room name can widen a pattern. Key enumeration also uses `SCAN` rather than `KEYS`. Note that this changes the redis key spelling for rooms whose org/docid/branch contain any of `!'()*`: their in-flight stream entries are orphaned by the upgrade and trimmed away, so persist before deploying if that applies to you. ([`src/stream.js`](src/stream.js))
- **`stopWorker` never stopped the worker.** `startWorker` looped on `this._ctx` while `stopWorker` mutated `this._workerCtx` — a different object — so the loop was unstoppable and the re-entrancy guard in `startWorker` was permanently false. ([`src/index.js`](src/index.js))
- **`assetIdFromString` threw on `id:contentids:v1`**, which had no case and fell through to the unknown-type error. ([`src/types.js`](src/types.js))

### Documentation

- `DEPLOYMENT.md` and `README.md` documented tables that do not exist (`yhub_updates_v1`, `yhub_attributions_v1`, and a `yhub_ydoc_v1` with the wrong columns). They now describe the real schema and point at `npm run start:init`.

## [0.5.0]

### Breaking Changes

- **Error codes now encode retry semantics on both APIs — new [Errors](API.md#errors) section in the API docs.** WebSocket close codes `4400`-`4499` are permanent — don't reconnect until the app acts; today only `4401` 'permission revoked', now also exported from `@y/hub` as `wsCloseAuthRevoked` — `4500`-`4599` are reserved for transient yhub errors, and standard codes are used where they fit (`1011` internal error, `1013` try again later), all transient: clients reconnect with backoff unless `code >= 4400 && code < 4500`. REST: retry `5xx` and `429`, treat any other `4xx` as permanent. Behavior changes:
  - An auth plugin failure during a websocket re-check now disconnects with the transient code `1013` (`'auth recheck failed'`) instead of `4401` — a temporarily unreachable auth backend no longer looks like a revoke, so clients that stop on `4401` (per the documented guidance) recover automatically once the backend is back. Signal denial from `getAccessType` by returning `null`, not by throwing. ([`src/server.js`](src/server.js))
  - The backpressure disconnect now sends close code `1013` — previously it sent `400`, which is not a legal websocket close code (RFC 6455 allows 1000-4999), so clients actually observed an abnormal `1006` close. ([`src/server.js`](src/server.js))
  - A websocket upgrade with insufficient access is rejected with `403 Forbidden` instead of `401 Unauthorized`, matching the REST endpoints (`401` = unauthenticated, `403` = no access). ([`src/server.js`](src/server.js))
- **`changeset`/`activity` responses are now served as `application/x-lib0any` instead of `application/octet-stream`.** Bodies are byte-identical — the cached pre-encoded lib0-any payload was always x-lib0any content mislabeled as opaque bytes. Decode by content type as documented and nothing changes; the label now also makes the two endpoints eligible for json transcoding (below). ([`src/builtin-api.js`](src/builtin-api.js))
- **Malformed `ydoc` PATCH / `rollback` / `prune` bodies now answer the framework's `400 { error: 'invalid body: ...', code: 'invalid-body' }`** instead of the handler-crafted `'Invalid request body'` / `'error consuming request'` messages — the built-ins declare their bodies via the new `$body` spec (below). Semantic checks keep their messages: a PATCH with neither `update` nor `awareness` still answers `'Invalid request body'`, rollback/prune without a filter keep their `'... requires at least one filter ...'` errors. ([`src/builtin-api.js`](src/builtin-api.js))

### New Features

- **Auth plugins can signal a temporary auth-backend outage: throw `apiError(503, ...)`.** A branded `apiError` thrown from `readAuthInfo`/`getAccessType` propagates its status and message on rest requests and the websocket upgrade instead of the fail-closed `401`, telling clients the failure is transient. Unbranded errors keep rejecting with `401`. `503 Service Unavailable` joined the known status lines. ([`src/api.js`](src/api.js), [`src/server.js`](src/server.js), [`src/types.js`](src/types.js))
- **Opt-in json encoding for the rest api.** lib0-any stays the default; json is strictly per-request. Responses: `Accept: application/json` (the literal media type — `*/*` does not opt in) serves object results — error bodies and the pre-encoded changeset/activity responses included — as `application/json` with `Uint8Array`/`Buffer` values as base64 strings (any nesting depth), `undefined` as `null` (key preserved), and `Date` as epoch millis; string, raw-byte, and `Response` returns are unaffected. Request bodies: `Content-Type: application/json` on endpoints that declare `$body` — `s.$uint8Array` fields accept base64 strings and arrive in the handler as real `Uint8Array`s. ([API docs](API.md#json-encoding), [`src/api.js`](src/api.js))
- **Declarative request bodies for custom api endpoints: `$body`.** A non-`get` method may declare its body like `$query` — a shape object or any prebuilt schema: `post: { $body: { text: s.$string, attachment: s.$uint8Array.optional }, handler }`. The framework awaits the body, decodes it by content type, and passes the validated value as **`req.body`** (typed by the spec via `createApiEndpoint`) — json bodies are coerced via `s.coerce` (base64 strings become `s.$uint8Array` values), lib0-any bodies express exact types and are validated unchanged; invalid bodies answer `400 { error, code: 'invalid-body' }` without invoking the handler. Methods without `$body` are unchanged (`req.body` is `undefined`; `req.bytes()`/`req.any()` remain). The built-in `ydoc` PATCH, `rollback`, and `prune` endpoints are implemented on it. ([API docs](API.md#request-body-body), [`src/api.js`](src/api.js), [`src/types.js`](src/types.js), [`src/builtin-api.js`](src/builtin-api.js))
- **The worker `docUpdate` event now carries the room.** The event object passed to `worker.events.docUpdate` includes a `room` property alongside the merged `DocTable` fields, so a single callback can tell which document was compacted. ([`src/index.js`](src/index.js), [`src/types.js`](src/types.js))
- **New export `encodedAny(bytes)`: mark handler-returned bytes as pre-encoded lib0-any.** They are served as `application/x-lib0any` without re-encoding and transcode to json on `Accept: application/json` like an object result — unlike a plain `Uint8Array` return, which stays opaque `application/octet-stream`. Use it for cached `encodeAny` payloads; the built-in changeset/activity endpoints respond this way. ([API docs](API.md#return-values), [`src/api.js`](src/api.js))

### Dependencies

- **Bumped `lib0` to `^1.0.0-rc.25`** for base64→`Uint8Array` coercion in `s.coerce`, which lets one compiled `$body` coercer accept both json (base64 strings) and lib0-any (native bytes) bodies. ([`package.json`](package.json))

## [0.4.0]

### Breaking Changes

- **All routes moved under the api prefix with name-first order `/{apiPrefix}/{name}/{version}/...`; the old top-level routes are removed.**
  | old | new |
  |---|---|
  | `GET`/`PATCH /ydoc/{org}/{docid}` | `GET`/`PATCH /api/ydoc/v1/{org}/{docid}` |
  | `POST /rollback/{org}/{docid}` | `POST /api/rollback/v1/{org}/{docid}` |
  | `POST /prune/{org}/{docid}` | `POST /api/prune/v1/{org}/{docid}` |
  | `GET /changeset/{org}/{docid}` | `GET /api/changeset/v1/{org}/{docid}` |
  | `GET /activity/{org}/{docid}` | `GET /api/activity/v1/{org}/{docid}` |
  | `ws://{host}/ws/{org}/{docid}` | `ws://{host}/api/ws/v1/{org}/{docid}` |

  Custom endpoints swap segments too: `/api/{version}/{name}/...` → `/api/{name}/{version}/...` (yhub versions per-endpoint, so an endpoint's versions now group under its name). The old top-level routes answer uws' default `404`. WebSocket clients update the provider `serverUrl` (`ws://{host}/api/ws/v1`); the `branch`/`gc`/`customAttributions` query params are unchanged. Note for browser apps: `y-websocket` derives its BroadcastChannel name from `serverUrl + '/' + roomname`, so cross-tab channel identities change with the URL — tabs on the old and new URL won't BC-sync with each other during a rollout. ([API docs](API.md), [`src/api.js`](src/api.js), [`src/server.js`](src/server.js))
- **The built-in rest endpoints are now ordinary default endpoints, implemented on the custom-endpoint framework.** ([`src/builtin-api.js`](src/builtin-api.js)) Consequences:
  - Their names are taken at `v1`: a custom endpoint named `ydoc`/`rollback`/`prune`/`changeset`/`activity`/`ws` at `v1` (same url depth) throws the duplicate-endpoint error at startup; other versions (e.g. `name: 'ydoc', version: 'v2'`) are free.
  - Query parameters are validated via `$query` specs: junk values that previously fell back to defaults (`?gc=xyz`, `?from=abc`, an empty `?from=`) now answer `400 { error, code: 'invalid-query' }`; numbers follow `Number()` semantics instead of `parseInt` (`'5abc'` → 400, `'1e3'` → 1000); repeated query keys resolve last-wins. Undeclared attributes (e.g. an auth token in `?yauth=`) still pass through.
  - The object-returning responses (`GET`/`PATCH /api/ydoc/v1`, `rollback`, `prune`) are served as `application/x-lib0any` instead of `application/octet-stream` — bodies byte-identical, decode by content type. `changeset`/`activity` keep returning `application/octet-stream`.
  - Internal failures during patch/rollback/prune (e.g. a compute error after a valid body) now answer `500 Internal server error` instead of a misleading `400`; body-shape errors keep their 400 messages.
  - Bug fix: multi-chunk request bodies are now copied out of uws' neutered buffers by the shared framework body reader.
- **Custom api endpoint methods are now `{ $query?, handler }` objects.** `get: async req => ...` becomes `get: { handler: async req => ... }` — startup throws `"get.handler must be a function"` on the old bare-function form. The method object is the extension point for per-method options: `$query` today, per-method permissions and body schemas later. ([API docs](API.md#endpoint-definition), [`src/api.js`](src/api.js), [`src/types.js`](src/types.js))
- **`req.query` on custom api endpoints is now a plain object, not `URLSearchParams`.** Read attributes as properties: `req.query.get('q')` → `req.query.q`. Values are raw strings unless declared in the method's `$query` (below); repeated keys now resolve last-wins (previously `.get()` returned the first). Note that the type system cannot flag stale `.get(...)` calls — `req.query` is `{ [key: string]: any }` without a `$query` spec — so grep for `query.get`. ([API docs](API.md#the-request-object), [`src/api.js`](src/api.js), [`src/types.js`](src/types.js))

### New Features

- **Declarative query attributes for custom api endpoints: `$query`.** A method may declare its supported query attributes as a shape object — values are lib0 schemas, literals, or arrays of those (= unions): `get: { $query: { limit: s.$number.optional, order: ['asc', 'desc'] }, handler }` (a prebuilt `s.$object(..)` / `s.$partial(..)` works too). Query values arrive as url strings and are coerced against each attribute's schema via lib0's new `s.coerce` (numeric strings → numbers, `'true'`/`'false'` → booleans, literals match their string form, unions/optionals descended), then validated **before the request object is created**: invalid or missing required attributes answer `400 { error, code: 'invalid-query' }` naming the attribute (e.g. `invalid query: [limit] "abc" doesn't match number`), without invoking the handler. Undeclared attributes pass through as raw strings. Doc-scoped endpoints may declare `branch` to constrain the requested branch (e.g. `branch: 'main'`) — the server default `'main'` is validated when `?branch` is omitted; undeclared `branch` passes through. Typing follows suit: with `createApiEndpoint`, `req.query` is typed by the method's `$query` spec (e.g. `req.query.limit: number|undefined`), and `{ [key: string]: any }` without one. ([API docs](API.md#query-attributes-query), [`src/api.js`](src/api.js), [`src/types.js`](src/types.js))
- **Configurable api prefix: `server.apiPrefix`.** Rename the `/api` namespace to match your product's URL scheme — e.g. `apiPrefix: 'collaboration'` serves every endpoint — built-in, custom, and the websocket route — under `/collaboration/{name}/{version}/...`. Default remains `'api'`. The prefix must be a single bare path segment; there is no reserved-name list — with everything living under the prefix, former built-in route names (even `ydoc` or `ws`) are valid prefixes. ([API docs](API.md#custom-api-endpoints), [`src/api.js`](src/api.js), [`src/types.js`](src/types.js))

### Dependencies

- **Bumped `lib0` to `^1.0.0-rc.23`** for `s.coerce`, which powers the `$query` coercion. ([`package.json`](package.json))

## [0.3.1]

### New Features

- **Custom API endpoints (`server.api`).** Define your own rest endpoints — served from the same process and guarded by the same auth plugin as the built-in endpoints — via a new config section. `server.api` is an **array of endpoint definitions** (so multiple sources — your app, later: plugins — contribute endpoints by concatenation), mounted under `/api/{version}/{name}/...`, a namespace **contractually reserved for integrator endpoints**: y/hub will never register a built-in route under `/api/*`. ([API docs](API.md#custom-api-endpoints), [`src/api.js`](src/api.js), [`src/types.js`](src/types.js))
  - **Endpoint definition:** `{ name, version = 'v1', scope = 'doc', path, accessPurpose, get/post/put/patch/delete }`. `name` and `version` are single path segments, so every request has the fixed shape `/api/{version}/{apiname}/...` — easy for proxies to inspect positionally, and route overlap is structurally impossible. One `name` may serve several routes with distinct url depths (a collection route plus an item route via `path: '/:commentId'`); duplicate `(name, version)` at the same depth throws at startup, as do invalid names, non-string versions/purposes, reserved path-param names (`org`/`docid`/`branch`), and endpoints without handlers.
  - **Scopes:** `'doc'` → `/api/{version}/{name}/{org}/{docid}` (default), `'org'` → `/api/{version}/{name}/{org}`, `'global'` → `/api/{version}/{name}`.
  - **Authorization is automatic:** `get` requires `'r'` access, all other methods require `'rw'`. The customization point is the endpoint's `accessPurpose`, forwarded to the auth callbacks as a trailing `purpose` argument — one auth plugin can grant `rw` for purpose `'comments'` even on read-only docs, or return `null` for purpose `'moderation'` unless the user is an admin, making an endpoint private. Purpose is advisory: a purpose-unaware plugin simply applies plain doc access.
  - **Handlers** are plain async functions receiving a snapshot request object: the `yhub` instance (`req.yhub.getDoc(req.room, ...)`, `stream`, `persistence`, `computePool`, `agentTask`), `room`/`org`/`docid`/`branch`, `params` (named `path` segments), `query` (`URLSearchParams`), lowercased `headers`, `authInfo`, `accessType`, a live `aborted` flag (check between expensive steps and return early — aborted connections are never responded to), and body readers `bytes()` / `any()` (lib0-any-decoded).
  - **Return values:** a `Response` is written as-is (full-control escape hatch, e.g. JSON for third-party consumers), `null`/`undefined` → `204 No Content`, a string → `text/plain`, a `Uint8Array` → raw `application/octet-stream`, and anything else is lib0-any-encoded as **`application/x-lib0any`** — a dedicated content type that keeps the wire self-describing (clients decode by content type: `x-lib0any` → `decodeAny`, `text/*` → text, else raw bytes).
  - **Errors:** throw `apiError(status, message, extra?)` (new export) to respond with a status code and an any-encoded `{ error: message, ...extra }` body — use `extra` for machine-readable fields like `{ code: 'comment-not-found' }`. Only branded `apiError`s expose their message; any other exception (including foreign errors carrying a `status`) is logged and produces a generic `500` without leaking internals.
  - **Scope-aware typings.** `ApiEndpoint`/`ApiRequest` are scope-discriminated unions, so handlers are typed by their endpoint's `scope` even as plain object literals: doc-scoped handlers see a non-null `req.room`, org-scoped handlers see `req.org` only. For endpoints defined in separate modules, the new **`createApiEndpoint(name, opts)`** helper (exported next to `createAuthPlugin`) provides the same typings and preserves the literal endpoint name for future typed clients.
- **Kick users when permissions change: `yhub.recheckAuth(room, { users?, forceDisconnect? })`.** **Only start using this feature after *all* servers and workers run this yhub version** — older processes cannot read a room stream that contains an `auth:check:v1` entry and stall on it until the entry is trimmed. Distributes an `auth:check:v1` directive on the room's Redis stream; every server re-evaluates `auth.getAccessType(authInfo, room)` for its matching connections and disconnects them with the new close code **`4401` (`'permission revoked'`)** when the access type changed — including `rw` → `r` downgrades: the client reconnects and resyncs at its new access level (updating write access in place would silently drop the client's subsequent edits). Fails closed on auth plugin errors. `users` selects connections: `null` = all, a string matches by `userid`, a plain object matches connections whose authInfo contains all of its top-level properties (deep-equality per property). `forceDisconnect: true` skips the re-check and just drops the sessions — reconnects re-authenticate immediately, so revoke access in the auth backend first. Pending directives are applied to connections that were being set up concurrently (re-checked once in the open handler; never force-kicked, so a re-authorized user can't be kick-looped by a stale entry). No built-in REST route — expose a purpose-guarded [custom endpoint](API.md#custom-api-endpoints) calling `req.yhub.recheckAuth(...)`. Internally, the worker's compaction guard now allowlists content message types (`ydoc:update:v1`/`prune:v1`), so directive-only streams are trimmed without persisting. ([API docs](API.md#yhubrecheckauthroom-opts), [`src/server.js`](src/server.js), [`src/index.js`](src/index.js))
- **Auth plugin: org/global access callbacks and the `purpose` argument.** `getAccessType(authInfo, room, purpose)` gains an optional trailing `purpose` parameter (`null`-ish for all built-in endpoints and WebSocket connections — compare loosely with `purpose == null`; existing plugins keep working unchanged). Two new optional callbacks authorize the non-doc scopes: `getOrgAccessType(authInfo, org, purpose)` and `getGlobalAccessType(authInfo, purpose)` — **fail-closed**: when missing, endpoints of that scope deny all access (403). `readAuthInfo` is now typed to allow returning `null` (→ 401), matching its long-standing runtime contract. ([API docs](API.md#authorization-and-purpose), [`src/types.js`](src/types.js))

### Bug Fixes

- **REST error responses now carry their actual HTTP status codes.** uws locks the response status to `200 OK` once the first header is written; the shared error/preflight helpers wrote the CORS headers *before* `writeStatus`, so every REST error (`400`/`401`/`403`/`500`) was actually delivered as HTTP `200` with an error body, and the CORS preflight as `200` instead of `204`. All response writers now write the status first. **Note for clients:** error detection via `response.ok` now works; clients that decoded error bodies out of `200` responses keep working (bodies are unchanged). Error responses are now also served as `application/x-lib0any` (previously `application/octet-stream`). ([`src/api.js`](src/api.js), [`src/server.js`](src/server.js))
- **CORS unblocked for PUT/DELETE and custom headers.** `Access-Control-Allow-Methods` now includes `PUT` and `DELETE`, `Access-Control-Allow-Headers` includes `Authorization`, and the `OPTIONS` preflight reflects the request's `Access-Control-Request-Headers` — so browser calls using those methods or custom headers (e.g. `x-request-id`) no longer fail preflight. ([`src/api.js`](src/api.js), [`src/server.js`](src/server.js))

### Development

- **Local MinIO now uses host ports 9010 (S3 API) / 9011 (console).** The default 9000/9001 are commonly taken by other MinIO instances on dev machines, so `compose.yaml` remaps them. Update your `.env`: `S3_PORT=9010`. ([`compose.yaml`](compose.yaml), [`.env.template`](.env.template))

## [0.3.0]

### Breaking Changes

- **Changeset & activity delta rendering moved to `Y.AttributionsRenderer`; the diffing renderer (`Y.createDiffRenderer`) is gone.** Deltas now render the document **as it was at `to`** — a point-in-time baseline (`renderedContent` = insertions − deletions ≤ `to`) with the `from`/`to`/`by`/`withCustomAttributions`-filtered attributions overlaid — instead of diffing a `prevDoc`/`nextDoc` pair. Response changes: `GET /changeset?ydoc=true` now returns a single `ydoc` (a partially garbage-collected document at `to`; deleted content outside the attribution window is gc'd, in-range deletes kept restorable) instead of `prevDoc`/`nextDoc`. `GET /activity` now always returns `{ activity: [...] }` (previously a bare array) — the top-level shape is stable — and gains `ydoc=true` (adds a shared `ydoc`, with each entry carrying a `renderedContent` IdSet) and `attributions=true` (per-entry attribution `ContentMap`). Render client-side with `Y.createAttributionsRenderer` on a `gc: false` doc — see [Rendering with AttributionsRenderer](API.md#rendering-with-attributionsrenderer). ([`src/compute-worker.js`](src/compute-worker.js), [`src/compute.js`](src/compute.js), [`src/server.js`](src/server.js))
- **`events.docUpdate` config callback signature changed.** Following the `@y/y` upgrade (its `Attributions` class was removed), the second argument passed to a configured top-level `events.docUpdate` is now a `ContentMap` (`{ inserts, deletes }` IdMaps) instead of a `Y.Attributions` instance. ([`src/types.js`](src/types.js))

### Dependencies

- **Bumped `@y/y` to `^14.0.0-rc.24` and `lib0` to `^1.0.0-rc.22`.** Adapts to the renamed Renderer API (`Y.TwosetRenderer` → `Y.AttributionsRenderer`) and `Y.createContentIdsFromDoc`'s new required `insertsContainDeletes` argument. Import-API consumers that share `@y/y` types with yhub should upgrade in lockstep. ([`package.json`](package.json))

## [0.2.26] - 2026-06-24

### Bug Fixes

- **Awareness-only rooms are no longer persisted as empty documents.** The compaction guard decided whether there was anything to store by comparing the last persisted clock against `lastClock` — the id of the room stream's last entry *of any type*. Because `awareness:v1` messages live on the same stream, they advanced `lastClock`, so a room that only ever received awareness updates (presence/cursors, no document edits) would be persisted on every compaction as an empty Yjs document — a wasteful `yhub_ydoc_v1` row plus S3 assets, keyed at the awareness clock. The guard now compares against the last *content* clock: the newest `ydoc:update:v1` **or** `prune:v1` message, with awareness excluded. Awareness-only streams take the trim-only path and are never persisted (they are still trimmed, and the stream is deleted once its entries age past `minMessageLifetime`); prune directives still trigger compaction. ([`src/index.js`](src/index.js))

### Internal

- **Compaction skips the document fetch + merge when there is nothing new to persist.** The worker previously called `getDoc` — which pulls the persisted ydoc blobs from S3/Postgres and runs both `mergeUpdates` passes — *before* it could tell whether anything had changed, so every self-re-enqueued compaction cycle on a live room paid that cost just to discover there was nothing to do. The worker now does a cheap pre-check first: it pulls the Redis stream and the persisted clock (`persistence.retrieveDoc(room, {})` — a single `SELECT t`, no S3) concurrently, computes the last content clock, and on the no-op path trims **without** fetching or merging the document. `getDoc` gained an optional `cachedMessages` so the persist path reuses the stream already pulled instead of reading Redis a second time. ([`src/index.js`](src/index.js))

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
- **`PATCH /ydoc/{org}/{docid}` awareness support.** Body shape is now `{ update?, awareness?, customAttributions? }` with both `update` and `awareness` optional (at least one required). `awareness` carries bare `encodeAwarenessUpdate(...)` bytes — the same format the WS path puts on the stream — and is distributed to all connected clients through the same Redis channel. `customAttributions` only applies to `update`. ([API docs](API.md#patch-apiydocv1orgdocid), [`src/server.js`](src/server.js))
- **`GET /ydoc/{org}/{docid}?awareness=true`.** Returns `{ doc, awareness? }` with `awareness` as the merged room awareness in bare-bytes format — round-trippable through PATCH and directly consumable by `applyAwarenessUpdate`. Omitted when the room has no awareness state. Default response shape (no flag) is unchanged. ([API docs](API.md#get-apiydocv1orgdocid), [`src/server.js`](src/server.js))

### Bug Fixes

- **Strip phantom local client in `mergeAwarenessUpdates`.** The y-protocols `Awareness` constructor seeds its own `clientID` via `setLocalState({})`, which leaked as a phantom empty-state client to every consumer of the merged bytes (WS initial sync, GET `/ydoc?awareness=true`). The merger now removes its own clientID before encoding, so the `byteLength > 3` "empty awareness" check on the WS initial-sync path is now actually correct. ([`src/protocol.js`](src/protocol.js))

### New Features

- **Configurable activity grouping.** The `GET /activity` endpoint accepts two new query parameters: `groupMaxGap` (maximum gap in milliseconds between consecutive changes by the same user that still merges them into one entry, default `1000` — previously hardcoded) and `groupMaxDuration` (maximum total span in milliseconds of a grouped entry, default unlimited). Both only apply when grouping is enabled.

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

- **PATCH /ydoc** - Accepts an optional `customAttributions` field (`Array<{ k: string, v: string }>`) in the request body. Custom attributions are stored alongside standard attributions as `insert:<key>` / `delete:<key>` attributes. ([API docs](API.md#patch-apiydocv1orgdocid), [`src/server.js`](src/server.js))
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
