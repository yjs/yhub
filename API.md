# Y/hub API Documentation

Y/hub is a collaborative document backend built on Yjs. It implements the standard y-websocket protocol and extends it with attribution, history management, and selective undo/redo capabilities.

---

## REST API

All endpoints require an `auth-cookie` which will be checked via the PERM
CALLBACK.

It is assumed that all documents can be identified by a unique `{org}/{docid}`
combination. Furthermore, all "body" content is encoded via lib0/encoding's
`encodeAny`. All binary data in parameters is encoded via base64.

### WebSocket

The standard WebSocket backend that is compatible with y-websocket, and TipTapProvider.

For each Yjs document, there is always a gc'd version, and a non-gc'd version.
Optionally, you may fork the document to a branch, which users can use for
implementing suggestions. Branched documents have a gc'd version and a non-gc'd
version as well.

* `ws://{host}/ws/{org}/{docid}` parameters: `{ gc?: boolean, branch?: string, customAttributions?: string }`
  * `gc=true` (default): standard garbage-collected document
  * `gc=false`: full document history which can be used to reconstruct editing history.
  * `branch="main"`: (default) The default branch-name if not specified otherwise.
  * `branch=string`: Optionally, define a custom branch. Changes won't be automatically synced with other branches.
  * `customAttributions=string`: optional comma-separated `key:value` pairs (e.g. `source:ai,model:gpt4`). All updates sent through this connection will include these custom attributions in the contentmap, stored as `insert:<key>` / `delete:<key>` attribution attributes alongside the standard ones.

### Ydoc

Retrieve and update the Yjs document via REST API.

#### GET /ydoc/{org}/{docid}

Retrieve the current state of the Yjs document.

* `GET /ydoc/{org}/{docid}` parameters: `{ gc?: boolean, branch?: string, awareness?: boolean }`
  * `gc=true` (default): retrieve the garbage-collected document
  * `gc=false`: retrieve the full document history (non-gc version)
  * `branch="main"` (default): the branch to retrieve
  * `awareness=true`: also include the room's merged awareness state in the response (default: omitted)
  * Returns `{ doc: Uint8Array, awareness?: Uint8Array }`. `doc` is the encoded Yjs document update. `awareness`, when requested and non-empty, contains the bare awareness update bytes (same format as `encodeAwarenessUpdate(...)` and as the `awareness` field accepted by `PATCH /ydoc`) — directly consumable by `applyAwarenessUpdate`. Omitted when the room has no awareness state.

#### PATCH /ydoc/{org}/{docid}

Update the Yjs document with new changes. Requires write access.

* `PATCH /ydoc/{org}/{docid}` body: `{ update?: Uint8Array, awareness?: Uint8Array, customAttributions?: Array<{ k: string, v: string }> }` parameters: `{ branch?: string }`
  * `update`: optional Yjs update (encoded via `Y.encodeStateAsUpdate` or similar). Diffed against the current document state — only new content is applied and attributed. Attributions are automatically assigned to the authenticated user.
  * `awareness`: optional awareness update bytes — the bare output of `encodeAwarenessUpdate(awareness, clientIds)` from `@y/protocols/awareness` (no `messageAwareness` wire-format prefix). Distributed to connected clients through the same Redis channel the WebSocket path uses.
  * `customAttributions`: optional array of key-value pairs to attach as custom attributions to the `update`'s changes. Stored as `insert:<key>` / `delete:<key>` attribution attributes alongside the standard ones. Has no effect when only `awareness` is supplied.
  * `branch="main"` (default): the branch to update
  * At least one of `update` or `awareness` must be present; an empty body returns `400 Bad Request`.
  * Changes are distributed to connected WebSocket clients.
  * Returns `{ success: true, message: string }` on success.

#### Example

```javascript
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

// Retrieve the current document
const getResponse = await fetch('/ydoc/my-org/my-doc-id')
const getBuffer = await getResponse.arrayBuffer()
const getDecoder = decoding.createDecoder(new Uint8Array(getBuffer))
const { doc } = decoding.readAny(getDecoder)

// Apply the remote state to a local document
const ydoc = new Y.Doc()
Y.applyUpdate(ydoc, doc)

// Make local changes
ydoc.getText('content').insert(0, 'Hello World')

// Encode the update and send it
const update = Y.encodeStateAsUpdate(ydoc)
const encoder = encoding.createEncoder()
encoding.writeAny(encoder, { update })
const body = encoding.toUint8Array(encoder)

const patchResponse = await fetch('/ydoc/my-org/my-doc-id', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/octet-stream' },
  body
})
```

### Rollback

Rollback all changes that match the pattern. The changes will be distributed via
websockets.

* `POST /rollback/{org}/{docid}` body: `{ from?: number, to?: number, by?: string, contentIds?: Y.ContentIds, customAttributions?: Array<{ k: string, v: string }>, withCustomAttributions?: Array<{ k: string, v: string }> }`
  * `from`/`to`: unix timestamp range filter
  * `by=string`: comma-separated list of user-ids that matches the attributions
  * `contentIds`: Changeset that describes the changes between two versions.
  * `customAttributions`: optional array of key-value pairs to attach as custom attributions to the rollback changes themselves (the undo operation).
  * `withCustomAttributions`: optional array of key-value pairs to filter which changes to undo. Only changes whose attributions match all specified key-value pairs will be rolled back.

#### Example

* Rollback all changes that happened after timestamp `X`: `POST /rollback/{org}/{docid}?from=X`
  * If your "versions" have timestamps, this call enables you to revert to a specific
    version of the document.
* Rollback all changes from user-id `U` that happened between timestamp `X` and `Y`: `POST /rollback/{org}/{docid}?by=U&from=X&to=Y`
  * This call enables you to undo all changes within a certain editing-interval.
* Rollback all changes of a certain user between two versions: `POST /rollback/{org}/{docid}` body: `{ by: userid, contentIds: Y.createContentIdsFromDocDiff(prevYDoc, nextYDoc) }`

### Changeset

Visualize attributed changes using either pure deltas or by retrieving the
before and after state of a Yjs doc. Optionally, include relevant attributions.

* `GET /changeset/{org}/docid` parameters: `{ from?: number, to?: number, by?: string, ydoc?: boolean, contentIds?: Y.ContentIds, delta?: boolean, attributions?: boolean, withCustomAttributions?: string }`
  * `from`/`to`: unix timestamp range filter
  * `by=string`: comma-separated list of user-ids that matches the attributions
  * `withCustomAttributions=string`: filter by custom attributions using `key:value` pairs, comma-separated (e.g. `source:import,tag:v2`). Only changes matching all specified attributions are included.
  * `contentIds`: Changeset that describes the changes between two versions. @todo not implemented
  * `ydoc=true`: include the encoded document **as it was at `to`** — a single partially garbage-collected Yjs update. Deleted content outside the attribution window is gc'd; in-range deletes are kept restorable.
  * `delta=true`: include the delta representation — the document at `to` with the in-range attributions highlighted.
  * `attributions=true`: include the attributions `ContentMap`.
  * Returns `{ ydoc?: Uint8Array, attributions?: Y.ContentMap, delta?: Delta }`.

The `ydoc` is the document at `to`; its alive content already *is* that point-in-time state, so you render its differences by applying it to a `gc: false` doc and overlaying the `attributions` with an `AttributionsRenderer` (see [Rendering with AttributionsRenderer](#rendering-with-attributionsrenderer)).

#### Example: visualize editing trail of the past day

* Retrieve activity `GET /activity/{org}/{docid}?from={now-1day}`
* Optionally, bundle changes that belong to each other: `[1, 2, 70, 71] ⇒ [2, 71]` - because `1,2` and `70,71` belong to each other.
* For each timestamp: `GET /changeset/{org}/{docid}?from=timestamps[I - 1]&to=timestamps[I]&delta=true&attributions=true`
* The `delta` renders the document as it was at `to`, with the changes attributed to the `[from, to]` interval highlighted.

### Activity

Retrieve all editing-timestamps for a certain document. Use
the activity API and the changeset API to reconstruct an editing trail.

* `GET /activity/{org}/{docid}` parameters: `{ from?: number, to?: number, by?: string, limit?: number, order?: string, group?: boolean, groupMaxGap?: number, groupMaxDuration?: number, delta?: boolean, withCustomAttributions?: string, customAttributions?: boolean, contentIds?: string }`
  * `from`/`to`: unix timestamp range filter
  * `by=string`: comma-separated list of user-ids to filter by
  * `withCustomAttributions=string`: filter by custom attributions using `key:value` pairs, comma-separated (e.g. `source:import,tag:v2`). Only changes matching all specified attributions are included.
  * `contentIds=string`: base64-encoded `Y.ContentIds` binary. When provided, only activity entries whose content intersects the given content set are returned. Encode via `buffer.toBase64(Y.encodeContentIds(contentIds))` (`import * as buffer from 'lib0/buffer'`).
  * `limit=number`: maximum number of entries to return
  * `order='asc'|'desc'`: `"asc"` (oldest first) or `"desc"` (newest first, default)
  * `group=boolean`: bundle consecutive changes from the same user into a single entry (experimental)
  * `groupMaxGap=number`: maximum time gap (in milliseconds) between consecutive changes by the same user that still merges them into a single entry (default: `1000`). Only applies when grouping is enabled.
  * `groupMaxDuration=number`: maximum total span (in milliseconds) of a grouped entry (`entry.to - entry.from`). A change is not merged into a group if the resulting span would exceed this value (default: unlimited). Only applies when grouping is enabled.
  * `delta=boolean`: include a delta representation for each activity entry — the document at that entry's `to`, with the entry's changes highlighted.
  * `ydoc=boolean`: return a single shared partially-gc'd document for the whole list, plus per entry a `renderedContent` IdSet (= content alive at the entry's `to`). The response shape becomes `{ ydoc, activity }`. Render any entry client-side by applying `ydoc` to a `gc: false` doc and overlaying an `AttributionsRenderer` with that entry's `renderedContent` (and `attributions`) — see [Rendering with AttributionsRenderer](#rendering-with-attributionsrenderer).
  * `attributions=boolean`: include each entry's attribution `ContentMap` (as `attributions: Uint8Array`).
  * `customAttributions=true`: include the list of custom attributions associated with each activity entry. When enabled, each entry includes a `customAttributions` field containing deduplicated `{ k, v }` pairs collected from the underlying attribution attributes (e.g. `insert:<key>`). When grouping is enabled, custom attributions from merged entries are combined and deduplicated.
  * Returns `{ activity: Array<{ from: number, to: number, by: string?, delta?: Delta, renderedContent?: Uint8Array, attributions?: Uint8Array, customAttributions?: Array<{ k: string, v: string }> }>, ydoc?: Uint8Array }`. The top-level shape is stable regardless of `ydoc`.
    * `ydoc` is present only when `ydoc=true`; `renderedContent` on each entry only when `ydoc=true`; `attributions` only when `attributions=true`; `customAttributions` only when `customAttributions=true`.

### Rendering with `AttributionsRenderer`

Both APIs return Yjs updates plus attribution metadata that you render with `@y/y`'s
`AttributionsRenderer`. Always apply the returned document to a **`gc: false`** doc so deleted
content can be restored for the diff.

**Changeset** — the returned `ydoc` is already the document at `to`, so the `attributions` alone
render the diff (its alive content is the point-in-time baseline):

```js
import * as Y from '@y/y'
const doc = new Y.Doc({ gc: false })
Y.applyUpdate(doc, changeset.ydoc)
const delta = doc.get().toDelta({
  renderer: Y.createAttributionsRenderer(Y.decodeContentMap(changeset.attributions))
})
```

**Activity** — one shared `ydoc` is re-projected to each entry's moment via that entry's
`renderedContent` (the content alive at the entry's `to`):

```js
const doc = new Y.Doc({ gc: false })
Y.applyUpdate(doc, res.ydoc)
const root = doc.share.keys().next().value || ''
res.activity.forEach(entry => {
  const renderer = Y.createAttributionsRenderer(
    Y.decodeContentMap(entry.attributions),
    { renderedContent: Y.decodeIdSet(entry.renderedContent) }
  )
  const delta = doc.get(root).toDeltaDeep({ renderer })
})
```

When `delta=true`, the server performs exactly this rendering and returns the result as
`changeset.delta` / `entry.delta`.

### Prune

Permanently prune *churned* history — content that was both inserted **and** deleted within the
requested range. The pruned content is garbage-collected from the document's history so it no longer
appears in the [activity](#activity) or [changeset](#changeset) APIs, making the stored history more
compact. Content that is still live (inserted but never deleted) and the document's *current visible
state* are never affected.

> **Warning:** pruning is irreversible. Once a worker bakes the prune into persistence, the removed
> history cannot be recovered. The operation is distributed as a directive on the Redis stream and
> applied the next time the document is retrieved or compacted.

* `POST /prune/{org}/{docid}` body: `{ from?: number, to?: number, by?: string, contentIds?: Y.ContentIds, withCustomAttributions?: Array<{ k: string, v: string }> }`
  * `from`/`to`: unix timestamp range filter. Only content whose insertion **and** deletion *both* fall within `[from, to]` is pruned.
  * `by=string`: comma-separated list of user-ids that matches the attributions
  * `contentIds`: restrict pruning to the changes described by a `Y.ContentIds`
  * `withCustomAttributions`: only prune content whose attributions match all specified key-value pairs
  * At least one filter is required; an empty body is rejected with `400`.
  * Returns `{ success: true }`.

#### Example

Given the edits `insert "a"` → `delete "a"` → `insert "b"`, the activity API can reconstruct all
three steps. Pruning a range that contains all three collapses the churned `"a"`, so only
`insert "b"` remains visible — the insertion of `"b"` is kept because it was never deleted.

* Compact all churn within an editing interval: `POST /prune/{org}/{docid}` body: `{ from: X, to: Y }`
* Compact only a specific user's churn in that interval: body: `{ from: X, to: Y, by: U }`
* Compact the **entire** document history — pass an all-encompassing range: body: `{ from: 0, to: Number.MAX_SAFE_INTEGER }`

```js
import * as buffer from 'lib0/buffer'

const prune = body => fetch(`http://${yhubHost}/prune/${org}/${docid}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: buffer.encodeAny(body)
})

// prune churn within a specific editing interval
await prune({ from: startTimestamp, to: endTimestamp })

// prune the entire history of the document
await prune({ from: 0, to: Number.MAX_SAFE_INTEGER })
```

The [activity](#activity) API supplies the timestamps that drive a prune. Pruning the range spanned
by two activity entries removes all the churn between them — effectively **merging** those two
entries into a single step in the timeline:

```js
import * as buffer from 'lib0/buffer'

// read the editing timeline (responses are lib0-encoded binary)
const res = await fetch(`http://${yhubHost}/activity/${org}/${docid}?group=false`)
const activity = buffer.decodeAny(new Uint8Array(await res.arrayBuffer()))

// merge activity entries `i..j`: prune everything that was inserted and deleted between them
await prune({ from: activity[i].from, to: activity[j].to })
```

### Custom API endpoints

Define your own rest endpoints — served from the same process and guarded by the same auth plugin
as the built-in endpoints — via the `server.api` config section. Every custom endpoint lives under
`/api/{version}/{name}/...`, a namespace that is **contractually reserved for your endpoints**:
y/hub will never register a built-in route under `/api/*`.

```js
import { createYHub, createAuthPlugin, apiError } from '@y/hub'

const yhub = await createYHub({
  // ...
  server: {
    port: 8080,
    auth: createAuthPlugin({ /* see below */ }),
    api: [
      // doc scope (default) → GET/POST /api/v1/comments/{org}/{docid}
      {
        name: 'comments',
        accessPurpose: 'comments', // forwarded to getAccessType as `purpose`
        get: async req => ({ comments: await readComments(req.room), viewer: req.authInfo.userid }),
        post: async req => {
          const { text } = await req.any()
          if (!text) throw apiError(400, 'text is required')
          await saveComment(req.room, req.authInfo.userid, text)
        }
      },
      // item route sharing the collection's name → GET /api/v1/comments/{org}/{docid}/{commentId}
      { name: 'comments', path: '/:commentId', get: async req => await getComment(req.room, req.params.commentId) },
      // a breaking revision of the same endpoint → GET /api/v2/comments/{org}/{docid}
      { name: 'comments', version: 'v2', get: async req => ({ comments: await readCommentsV2(req.room) }) },
      // org scope → GET /api/v1/docs/{org}
      { name: 'docs', scope: 'org', get: async req => ({ docs: await listDocs(req.org) }) },
      // global scope → GET /api/v1/stats
      { name: 'stats', scope: 'global', get: async req => ({ uptime: process.uptime() }) }
    ]
  }
})
```

#### Endpoint definition

`server.api` is an array of endpoint definitions, so multiple sources (your app, plugins) can
contribute endpoints by concatenation. One `name` may serve several routes with distinct url
depths — that's how a collection route and an item route (`path: '/:commentId'`) share one
resource name. Two endpoints with the same `(name, version)` and the same url depth throw at
startup.

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | — | required; a single path segment (`^[A-Za-z0-9_-]+$`). Prefer camelCase — the name doubles as a property name in future typed clients. |
| `version` | `string` | `'v1'` | a single path segment; bump for breaking revisions of an endpoint |
| `scope` | `'doc' \| 'org' \| 'global'` | `'doc'` | route shape: `/api/{version}/{name}/{org}/{docid}`, `/api/{version}/{name}/{org}`, or `/api/{version}/{name}` |
| `path` | `string` | `''` | extra named path segments appended to the route, e.g. `'/:commentId'` (named params only, available via `req.params`) |
| `accessPurpose` | `string` | `null` | forwarded as `purpose` to the auth access callback (see below) |
| `get`, `post`, `put`, `patch`, `delete` | `(req) => any` | — | async handlers; at least one is required. `get` requires `'r'` access, all other methods require `'rw'`. |

Because names and versions are single segments, every request under `/api/` has the fixed shape
`/api/{version}/{apiname}/...` — easy for proxies to inspect positionally.

Handlers are typed by `scope`: doc-scoped handlers receive a non-null `req.room`, org-scoped
handlers receive `req.org` only, global handlers neither. Plain object literals inside `api: [...]`
get these typings automatically. For endpoints defined in separate modules (where contextual typing
can't reach), use the `createApiEndpoint` helper — it also preserves the literal endpoint name for
tooling:

```js
import { createApiEndpoint } from '@y/hub'

export const comments = createApiEndpoint('comments', {
  get: async req => ({ comments: await readComments(req.room) }) // req.room: Room (non-null)
})
```

#### Authorization and `purpose`

Access requirements are automatic: `get` requires `'r'`, all other methods require `'rw'`. The
customization point is the endpoint's `accessPurpose`, which the auth callbacks receive as the
trailing `purpose` argument:

```js
createAuthPlugin({
  async readAuthInfo (req) { /* unchanged */ },
  // purpose is the accessPurpose of a custom api endpoint (null when unset). Built-in endpoints
  // and websocket connections don't supply it - treat `purpose == null` (loose) as "no purpose".
  async getAccessType (authInfo, room, purpose) {
    if (purpose === 'comments') return 'rw' // e.g. allow commenting on read-only docs
    if (purpose === 'moderation') return isAdmin(authInfo) ? 'rw' : null // admin-only endpoint
    return lookupDocAccess(authInfo, room)
  },
  // authorize org-scoped custom endpoints. When missing, org-scoped endpoints deny all access.
  async getOrgAccessType (authInfo, org, purpose) { return lookupOrgAccess(authInfo, org) },
  // authorize global-scoped custom endpoints. When missing, global-scoped endpoints deny all access.
  async getGlobalAccessType (authInfo, purpose) { return 'r' }
})
```

Note that `purpose` is advisory: a `getAccessType` implementation that ignores it simply applies
the user's plain doc access to every doc-scoped endpoint. An endpoint's `accessPurpose` broadens or
narrows access only when the auth plugin acts on it.

#### The request object

Handlers receive a single request object. All properties are plain snapshots — safe to access at
any time, also after `await`s:

| Property | Type | Description |
|---|---|---|
| `yhub` | `YHub` | the yhub instance — query documents via `yhub.getDoc(req.room, ...)`, access `stream`, `persistence`, `computePool`, `agentTask` |
| `method` | `string` | `'get' \| 'post' \| 'put' \| 'patch' \| 'delete'` |
| `path` | `string` | the request path, e.g. `/api/v1/comments/acme/readme` |
| `org` | `string \| null` | `null` for global scope |
| `docid`, `branch`, `room` | | only set for doc scope; `branch` from `?branch=` (default `'main'`) |
| `params` | `{ [name]: string }` | the named path segments declared via `path` |
| `query` | `URLSearchParams` | parsed url query |
| `headers` | `{ [name]: string }` | lowercased request headers |
| `authInfo` | | whatever `readAuthInfo` returned |
| `accessType` | `'r' \| 'rw'` | the granted access |
| `aborted` | `boolean` | becomes `true` when the client disconnects — check between expensive steps and return early |
| `bytes()` | `() => Promise<Uint8Array>` | the raw request body |
| `any()` | `() => Promise<any>` | the request body, lib0-any-decoded |

#### Return values

| Handler returns | Response |
|---|---|
| `Response` | status, headers, and body are taken from the `Response` — the full-control escape hatch. The default CORS headers are added unless the `Response` sets its own `Access-Control-Allow-Origin`; `content-length`/`transfer-encoding` are managed by the server. |
| `undefined` / `null` | `204 No Content` |
| `string` | `200`, `text/plain; charset=utf-8` |
| `Uint8Array` / `Buffer` | `200`, `application/octet-stream`, as-is |
| anything else | `200`, `application/x-lib0any`, lib0-any-encoded — the same encoding all built-in endpoints use. The dedicated content type keeps the wire self-describing: clients decode by content type (`x-lib0any` → `decodeAny`, `text/*` → text, else raw bytes). |

Throw `apiError(status, message, extra?)` (exported by `@y/hub`) to respond with a specific status
code and an any-encoded `{ error: message, ...extra }` body — use `extra` for machine-readable
fields, conventionally `{ code: 'comment-not-found' }`. Any other exception is logged and produces
a generic `500` without leaking internals.

```js
import * as buffer from 'lib0/buffer'

// call a custom endpoint
const res = await fetch(`http://${yhubHost}/api/v1/comments/${org}/${docid}`)
const { comments } = buffer.decodeAny(new Uint8Array(await res.arrayBuffer()))
```

### YHub Import API

The `YHub` class is available when importing `@y/hub` directly. It exposes methods for reading and writing documents programmatically, bypassing the WebSocket and REST layers. This is useful for server-side scripts, migrations, and data pipelines.

#### `createYHub(config)`

```js
import { createYHub } from '@y/hub'
const yhub = await createYHub(config)
```

| Field | Type | Required | Description |
|---|---|---|---|
| `redis.url` | `string` | yes | Redis connection URL |
| `redis.prefix` | `string` | yes | Key prefix for all Redis entries (use a unique value per environment) |
| `redis.taskDebounce` | `number` | no | Milliseconds before a worker picks up a compaction task. Default: 120 000 |
| `redis.minMessageLifetime` | `number` | no | Minimum time in ms that update messages are kept in Redis streams before compaction. Default: 60 000 |
| `redis.cacheTtl` | `number` | no | TTL in seconds for cached API responses. Default: 10 |
| `redis.clientOptions` | `object` | no | Additional options passed to the node-redis client, e.g. `{ pingInterval: 10000 }`. YHub still controls `url`; `redis.socket` is merged into the final socket config; `clientOptions.scripts` are merged with YHub's Lua scripts. |
| `redis.socket` | `object` | no | Custom socket options merged into the Redis client socket config. See [node-redis socket options](https://github.com/redis/node-redis/blob/master/docs/client-configuration.md#socket-options) for available options. |
| `postgres` | `string` | yes | PostgreSQL connection string |
| `persistence` | `PersistencePlugin[]` | yes | One or more storage plugins (e.g. `S3PersistenceV1`). At least one is required. |
| `computePoolSize` | `number` | no | Worker threads in the compute pool for CPU-intensive Yjs work (merging, state vectors, changesets). Default: number of cpus - 1. Set this explicitly when the process is restricted to a subset of cores — `os.cpus().length` does not reflect `taskset` or cgroup limits. |
| `server` | `object \| null` | no | HTTP/WebSocket server config. Set to `null` to run without a server (worker/script mode). |
| `server.port` | `number` | yes* | Port to listen on |
| `server.auth` | `AuthPlugin` | yes* | Auth plugin created with `createAuthPlugin`. `getAccessType(authInfo, room, purpose)` receives the `accessPurpose` of custom api endpoints as `purpose` (null-ish otherwise). The optional `getOrgAccessType(authInfo, org, purpose)` / `getGlobalAccessType(authInfo, purpose)` callbacks authorize org-/global-scoped custom endpoints — when missing, endpoints of that scope deny all access. |
| `server.api` | `ApiSpec[]` | no | Custom rest endpoints served under `/api/{version}/{name}/...`. See [Custom API endpoints](#custom-api-endpoints). |
| `server.maxDocSize` | `number` | no | Maximum Ydoc size in bytes, used for WebSocket payload limits. Default: 500 MB |
| `worker` | `object \| null` | no | Background compaction worker config. Set to `null` to disable. |
| `worker.taskConcurrency` | `number` | yes* | Maximum number of compaction tasks to process in parallel |
| `worker.events.docUpdate` | `function` | no | Called after each compaction with the merged `DocTable` |

**Example: full server setup**

```js
import { createYHub, createAuthPlugin } from '@y/hub'
import { S3PersistenceV1 } from '@y/hub/plugins/s3'

const yhub = await createYHub({
  redis: {
    url: 'redis://localhost:6379',
    prefix: 'yhub:prod',
    // Optional: pass node-redis client options, such as keepalive PINGs.
    // clientOptions: { pingInterval: 10000 },
    // Optional: custom socket options for TLS, etc.
    // socket: { rejectUnauthorized: false, ca: fs.readFileSync('/path/to/ca.pem', 'utf-8') }
  },
  postgres: 'postgres://user:pass@localhost/yhub',
  persistence: [
    new S3PersistenceV1({ bucket: 'my-bucket', /* ... */ })
  ],
  server: {
    port: 8080,
    auth: createAuthPlugin({
      async readAuthInfo (req) { return { userid: req.getHeader('x-user-id') } },
      async getAccessType (authInfo, room) { return 'rw' }
    })
  },
  worker: { taskConcurrency: 10 }
})
```

**Example: script / worker-only mode (no HTTP server)**

```js
const yhub = await createYHub({
  redis: { url: 'redis://localhost:6379', prefix: 'yhub:prod' },
  postgres: 'postgres://user:pass@localhost/yhub',
  persistence: [ new S3PersistenceV1({ /* ... */ }) ],
  server: null,
  worker: null
})
```

#### `yhub.getDoc(room, include, opts?)`

Retrieve the current state of a document, merging any in-memory Redis updates with the persisted state.

```ts
yhub.getDoc(
  room: { org: string, docid: string, branch: string },
  include: {
    gc?: boolean,
    nongc?: boolean,
    contentmap?: boolean,
    contentids?: boolean,
    references?: boolean,
    awareness?: boolean
  },
  opts?: { gcOnMerge?: boolean }  // default: true
): Promise<{
  gcDoc: Uint8Array | null,
  nongcDoc: Uint8Array | null,
  contentmap: Uint8Array | null,
  contentids: Uint8Array | null,
  references: Array<{ assetId, asset }> | null,
  awareness: Uint8Array | null,
  lastClock: string,
  lastPersistedClock: string
}>
```

Only fields listed in `include` with a truthy value are populated; the rest are `null`. Set `gcOnMerge: false` to keep full history in the returned `gcDoc`.

**Example**

```js
import * as Y from '@y/y'

const { gcDoc } = await yhub.getDoc(
  { org: 'my-org', docid: 'my-doc', branch: 'main' },
  { gc: true }
)
const ydoc = Y.createDocFromUpdate(gcDoc)
```

#### `yhub.unsafePersistDoc(room, update, attributions)`

Attribute and persist a Yjs update directly to the database, without distributing it via Redis or WebSocket. Multiple calls for the same room are merged on next retrieval.

> **Warning:** connected clients will not see the changes until they reconnect.

```ts
yhub.unsafePersistDoc(
  room: { org: string, docid: string, branch: string },
  update: Uint8Array,          // encoded Yjs update (e.g. Y.encodeStateAsUpdate)
  attributions: { by?: string } // optional author user-id
): Promise<void>
```

**Example**

```js
import * as Y from '@y/y'

const ydoc = new Y.Doc()
ydoc.getText('content').insert(0, 'Hello from a script')

await yhub.unsafePersistDoc(
  { org: 'my-org', docid: 'my-doc', branch: 'main' },
  Y.encodeStateAsUpdate(ydoc),
  { by: 'import-script' }
)
```

#### `yhub.pruneDoc(room, filters)`

Permanently prune *churned* history — content that was both inserted **and** deleted within the
filtered range. The prune is distributed via the Redis stream and baked into persistence on the next
compaction. This is the programmatic equivalent of `POST /prune/{org}/{docid}`.

> **Warning:** pruning is irreversible. Live content (inserted but never deleted) and the current
> visible document state are never affected.

```ts
yhub.pruneDoc(
  room: { org: string, docid: string, branch: string },
  filters: {
    from?: number,
    to?: number,
    by?: string,
    contentIds?: Uint8Array,                              // encoded Y.ContentIds
    withCustomAttributions?: Array<{ k: string, v: string }> | null
  }
): Promise<void>
```

Provide at least one filter. If no churned content matches the filters, the call is a no-op.

**Example**

```js
const room = { org: 'my-org', docid: 'my-doc', branch: 'main' }

// Compact all churn from the last hour
await yhub.pruneDoc(room, { from: Date.now() - 60 * 60 * 1000, to: Date.now() })

// Compact the entire document history
await yhub.pruneDoc(room, { from: 0, to: Number.MAX_SAFE_INTEGER })
```

#### `yhub.recheckAuth(room, opts?)`

Force a permission re-check for the WebSocket connections of a room — use it when permissions on a
document changed and connected clients should be affected immediately, not just on their next
connect. The directive is distributed via the Redis stream, so it reaches connections on **all**
servers. Each matching connection re-evaluates `auth.getAccessType(authInfo, room)` and is
disconnected with close code `4401` (`'permission revoked'`) when its access type changed —
including an `rw` → `r` downgrade (the client reconnects, re-authenticates, and resyncs at its new
access level; a still-revoked client is rejected with `401 Unauthorized` at upgrade). A failing
auth plugin fails closed: the connection is disconnected.

```ts
yhub.recheckAuth(
  room: { org: string, docid: string, branch: string },
  opts?: {
    users?: Array<string | { [key: string]: any }> | null,  // default: null = every connection
    forceDisconnect?: boolean                               // default: false
  }
): Promise<void>
```

**Matchers.** `users: null` matches every connection in the room. A string matches connections with
that `userid`. A plain object matches a connection when each of its top-level properties deep-equals
the corresponding property of the connection's authInfo — the authInfo may have additional
properties, so `{ userid: 'X' }` matches the authInfo `{ userid: 'X', name: 'Kevin' }`, and `{}`
matches everything. Properties are compared with deep equality as a whole (no recursive subset
matching: `{ roles: ['editor'] }` does not match an authInfo with `roles: ['editor', 'admin']`).
Matchers must be plain JSON-ish values from trusted code — values that don't survive lib0
`encodeAny` are unsupported: functions never match, while a `Date` or `Map` decodes to the empty
object `{}` and therefore matches **every** connection.

**`forceDisconnect: true`** disconnects matching connections *without* re-checking. This drops
sessions, it does not revoke access: clients auto-reconnect and re-authenticate within
milliseconds, so revoke in your auth backend first. Force-disconnecting every connection of a busy
room causes a reconnect thundering herd — all clients re-run the upgrade auth and initial sync at
once.

**Client handling.** `@y/websocket` reconnects indefinitely by default — a kicked, still-revoked
client retries every ≤2.5s, hitting your auth backend with a 401 each time. Handle the close code
in the app:

```js
provider.on('connection-close', event => {
  if (event?.code === 4401) provider.disconnect() // permission revoked - stop reconnecting
})
```

**Auth plugin contract.** The re-check reuses the `authInfo` captured at connect (`readAuthInfo`
cannot be re-run — the original HTTP request is gone). `getAccessType` must consult a live
authority (database, permission service) for the re-check to be meaningful; if access is derived
from claims embedded in the authInfo itself (e.g. rooms listed in a JWT payload), a re-check
recomputes the same stale answer — rely on `forceDisconnect` plus short token TTLs instead.

There is deliberately no built-in REST route: expose it as a [custom API endpoint](#custom-api-endpoints)
guarded by your own `accessPurpose` if you need HTTP access:

```js
createApiEndpoint('recheck-auth', {
  accessPurpose: 'admin',
  post: async req => { await req.yhub.recheckAuth(req.room, await req.any()) }
})
```

> **Rolling upgrades:** servers and workers running a version older than this feature fail reading
> a room stream that contains an `auth:check:v1` entry (for up to `minMessageLifetime`). Deploy the
> new version to all processes before the first `recheckAuth` call.

#### `persistence.listRoomAssets(room)`

Every asset persisted for a room, decoded from the row columns. Does **not** call the persistence
plugins, so it never fetches from object storage.

```ts
persistence.listRoomAssets(
  room: { org: string, docid: string, branch: string }
): Promise<Array<{ assetId: AssetId, asset: Asset }>>
```

Use this rather than `retrieveDoc(room, { references: true })` when the list has to be complete:
`retrieveDoc` only reports a reference once the plugin *retrieve* for it succeeded, so an object
that is temporarily unreadable hides its row — and with it the `assetId` needed to ever delete
that object. For reads that is a sensible degradation; for deletion or inventory it silently
under-reports.

#### `persistence.deleteReferencesNow(references)`

Like [`deleteReferences`](#), but deletes each asset from the persistence plugins **first**,
awaiting every one, and removes the database rows only once all of them are confirmed gone.
Rejects instead of leaving rows that point at surviving objects.

```ts
persistence.deleteReferencesNow(
  references: Array<{ assetId: AssetId, asset: Asset }>
): Promise<void>
```

`deleteReferences` is tuned for compaction: it schedules the plugin deletes without awaiting them
(a slow object store can't stall compaction, and readers still holding the previous `t` keep
working) and always removes the rows. That trade-off is right there, but it means a failed object
delete leaves data behind with nothing pointing at it. Use `deleteReferencesNow` when the deletion
has to be verifiable — deleting a document for good, or satisfying a data-retention requirement.

Requires the configured plugins to implement `deleteNow`; rejects if no plugin claims an asset,
rather than skipping it.

```js
// permanently delete one room, verifiably
const assets = await yhub.persistence.listRoomAssets(room)
await yhub.persistence.deleteReferencesNow(assets)
// throws unless every object *and* row is gone
```

> Deleting persisted rows does not stop the document coming back: `store()` is an insert, so a
> later compaction of stream residue re-creates it. Disconnect writers first — e.g.
> [`recheckAuth(room, { forceDisconnect: true })`](#yhubrecheckauthroom-opts) — and disable
> compaction for the room.

#### `PersistencePlugin.deleteNow(assetId, assetInfo)`

Optional counterpart to `delete`. Deletes immediately, awaits completion, and rejects on failure,
so callers can rely on the object being gone. `delete` remains the deferred, fire-and-forget
variant used by compaction. A plugin returns `false` when the asset isn't its own.

#### `yhub.agentTask(room, opts, handler)`

Run an LLM agent task against a room. The handler receives a freshly hydrated `Y.Doc` (snapshot of the room's current state) and a new `Awareness` instance bound to it. Edits made inside the handler are streamed to all connected clients in real time with attribution derived from the options. The returned promise resolves with the handler's return value **only after** the agent's awareness has been cleared.

```ts
yhub.agentTask(
  room: { org: string, docid: string, branch: string },
  opts: {
    author?: string,             // user-id recorded as `insert` / `delete`
    displayedAuthor?: string,    // awareness `user.name` (defaults to `author`)
    promptBy?: string,           // sugar for customAttributions: [{ k: 'promptBy', v: promptBy }]
    customAttributions?: Array<{ k: string, v: string }>,
    clearAwareness?: number | false  // seconds; 0 = immediate (default); false = leave in place
  },
  handler: (ydoc: Y.Doc, awareness: Awareness) => Promise<R> | R
): Promise<R>
```

Behavior:

* The handler's `ydoc` is a snapshot at task start; concurrent edits from other clients during the task are **not** merged back in. The handler's own edits are still distributed live.
* `author` flows into the standard `insert` / `delete` content attributions, the same way the authenticated user-id does on the WS and REST paths. `customAttributions` entries become `insert:${k}` / `delete:${k}` attributions, matching the `customAttributions` shape accepted by `PATCH /ydoc` and the WebSocket query param. `promptBy` is sugar for one such entry and is merged with any explicit `customAttributions`.
* `displayedAuthor` is pre-seeded into the agent's awareness as `{ user: { name: displayedAuthor } }` so other clients can render the agent (cursor labels, presence panels). It is **never** recorded in the contentmap. The handler can replace or augment it with `awareness.setLocalState(...)`.
* On success, awareness is cleared after `clearAwareness` seconds (default `0` = immediately; `false` = don't clear). On any error — from the handler or from the underlying stream forwarding — awareness is cleared **immediately** regardless of `clearAwareness`, and the error is re-thrown from the returned promise.

**Example**

```js
await yhub.agentTask(
  { org: 'my-org', docid: 'my-doc', branch: 'main' },
  {
    author: 'agent-user-id',
    displayedAuthor: 'Claude',
    promptBy: 'kevin-user-id',
    customAttributions: [{ k: 'model', v: 'opus-4.7' }],
    clearAwareness: 20
  },
  async (ydoc, awareness) => {
    // awareness already advertises { user: { name: 'Claude' } }
    ydoc.get().applyDelta(delta.create().insert('Hello from the agent').done())
  }
)
```
