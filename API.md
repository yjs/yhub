# Y/hub API Documentation

Y/hub is a collaborative document backend built on Yjs. It implements the standard y-websocket protocol and extends it with attribution, history management, and selective undo/redo capabilities.

---

## REST API

All endpoints require an `auth-cookie` which will be checked via the PERM
CALLBACK.

It is assumed that all documents can be identified by a unique `{org}/{docid}`
combination. Furthermore, all "body" content is encoded via lib0/encoding's
`encodeAny` by default. All binary data in parameters is encoded via base64.
Clients without a lib0 decoder can opt into json per request — see
[JSON encoding](#json-encoding).

### WebSocket

The standard WebSocket backend that is compatible with y-websocket, and TipTapProvider.

For each Yjs document, there is always a gc'd version, and a non-gc'd version.
Optionally, you may fork the document to a branch, which users can use for
implementing suggestions. Branched documents have a gc'd version and a non-gc'd
version as well.

* `ws://{host}/api/ws/v1/{org}/{docid}` parameters: `{ gc?: boolean, branch?: string, customAttributions?: string }`
  * `gc=true` (default): standard garbage-collected document
  * `gc=false`: full document history which can be used to reconstruct editing history.
  * `branch="main"`: (default) The default branch-name if not specified otherwise.
  * `branch=string`: Optionally, define a custom branch. Changes won't be automatically synced with other branches.
  * `customAttributions=string`: optional comma-separated `key:value` pairs (e.g. `source:ai,model:gpt4`). All updates sent through this connection will include these custom attributions in the contentmap, stored as `insert:<key>` / `delete:<key>` attribution attributes alongside the standard ones.

### Errors

Every yhub error is either **transient** — retry with backoff — or **permanent** — retrying
yields the same result until the app acts. Classification is by range, so clients stay correct
when codes are added:

* **WebSocket:** reconnect with backoff — unless `code >= 4400 && code < 4500`, then stop.
* **REST:** retry `5xx` and `429` with backoff; every other `4xx` is permanent.

#### WebSocket close codes

| Close code | Meaning | Reconnect? |
|---|---|---|
| `4400`–`4499` | permanent yhub errors — `4401` permission revoked (see [`yhub.recheckAuth`](#yhubrecheckauthroom-opts); exported as `wsCloseAuthRevoked`), `4404` document deleted (see [`yhub.deleteDoc`](#yhubdeletedocroom-opts); exported as `wsCloseDocDeleted`) | no — act first (e.g. re-authenticate, or drop the local copy), then reconnect deliberately |
| `4500`–`4599` | reserved for transient yhub errors (none sent today) | yes |
| `1011` | internal error — initial sync, message handling, or stream relay failed | yes |
| `1013` | try again later — backpressure limit exceeded, or the auth backend was unavailable during a re-check | yes |
| `1002` `1003` `1008` | standard permanent codes — yhub never sends them | no |
| *(none)* | closed without a close frame — browsers report `1006`, `@y/websocket` emits `connection-close` with `event = null` | yes |

A missing close frame is routine: server shutdown, the 120s idle timeout (pings are sent
automatically — only a dead link times out), and network or proxy failures. Always transient.

A denied upgrade is HTTP, never a close code: `401` unauthenticated, `403` insufficient access
or an origin the CORS config does not allow (see [CORS](#cors)),
or the status of a branded `apiError` thrown by the auth plugin (e.g. `503` while its backend is
down). Browsers can't observe upgrade statuses — the client only sees a failed connection
attempt. `4401` is the explicit stop signal; a client that ignores it reconnects into a `403`
loop against your auth backend.

`@y/websocket` reconnects after **every** close, regardless of code — apply the rule in the app:

```js
provider.on('connection-close', event => {
  // event == null: closed without a close frame - transient, keep reconnecting
  if (event != null && event.code >= 4400 && event.code < 4500) {
    provider.disconnect() // permanent - stop; provider.connect() re-arms after e.g. re-auth
  }
})
```

Future yhub close codes follow the band rule: the band is normative, the trailing digits are an
HTTP mnemonic only — a retryable rate-limit close would be `45xx`, never `4429`.

#### REST status codes

Error responses carry a lib0-any encoded `{ error: string, ...extra }` body (see
[Return values](#return-values)) — json instead when the request sent
`Accept: application/json` (see [JSON encoding](#json-encoding)).

| Status | Sent when | Retry? |
|---|---|---|
| `400` `404` `409` `422` | caller mistake — invalid body or query (`code: 'invalid-body'` / `'invalid-query'`), missing resource, conflict | no — fix the request |
| `401` `403` | unauthenticated / no access | no — obtain fresh credentials, then send a new request |
| `403` with `code: 'origin-not-allowed'` | the page's origin is not allowed by `server.cors` (see [CORS](#cors)) — always json | no — fix the server's cors config, not the credentials |
| `429` | rate limited — yhub itself never sends this; reserved for proxies and custom endpoints | yes — back off first |
| `500`–`599` | server-side failure — `500` internal error, `503` a dependency (e.g. the auth backend) is temporarily down | yes |

### JSON encoding

The lib0-any encoding is the default because it round-trips types json can't (binary data,
`undefined`). Clients that prefer json opt in per request — the default never changes:

* **Responses**: send `Accept: application/json` (the literal media type — a generic `*/*` does
  *not* opt in). Object results — including error bodies and the pre-encoded changeset/activity
  responses — are served as `application/json` instead of `application/x-lib0any`. String
  (`text/plain`) and raw byte (`application/octet-stream`) responses are unaffected.
* **Request bodies**: send `Content-Type: application/json` to an endpoint that declares a
  [`$body` spec](#request-body-body) — all built-in body-accepting endpoints (`ydoc` PATCH,
  `rollback`, `prune`) do. Fields declared as `s.$uint8Array` accept base64 strings and arrive in
  the handler as real `Uint8Array`s. Without the json content type, the body is lib0-any-decoded
  and validated against the spec without coercion.

Values are mapped to json as follows:

| Value | JSON |
|---|---|
| `Uint8Array` / `Buffer` (any nesting depth) | base64 string — decode with `buffer.fromBase64` (`lib0/buffer`) |
| `undefined` | `null`, the key is preserved |
| `Date` | epoch milliseconds number |

In json request bodies, binary fields take canonical padded base64. Omit absent optional fields
rather than sending `null`.

```js
// json client - no lib0 required
const res = await fetch(`/api/ydoc/v1/${org}/${docid}`, { headers: { Accept: 'application/json' } })
const { doc } = await res.json() // doc is a base64 string
await fetch(`/api/ydoc/v1/${org}/${docid}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ update: updateAsBase64 })
})
```

### Ydoc

Retrieve and update the Yjs document via REST API.

#### GET /api/ydoc/v1/{org}/{docid}

Retrieve the current state of the Yjs document.

* `GET /api/ydoc/v1/{org}/{docid}` parameters: `{ gc?: boolean, branch?: string, awareness?: boolean }`
  * `gc=true` (default): retrieve the garbage-collected document
  * `gc=false`: retrieve the full document history (non-gc version)
  * `branch="main"` (default): the branch to retrieve
  * `awareness=true`: also include the room's merged awareness state in the response (default: omitted)
  * Returns `{ doc: Uint8Array, awareness?: Uint8Array }`. `doc` is the encoded Yjs document update. `awareness`, when requested and non-empty, contains the bare awareness update bytes (same format as `encodeAwarenessUpdate(...)` and as the `awareness` field accepted by `PATCH /api/ydoc/v1`) — directly consumable by `applyAwarenessUpdate`. Omitted when the room has no awareness state.
  * A deleted document answers `404 Not Found` with `{ error: 'Not Found', code: 'doc-deleted' }`. The `code` matters: a docid that was never written answers `200` with an empty document, so it is the only way to tell "deleted" from "never existed".

#### DELETE /api/ydoc/v1/{org}/{docid}

Delete a document. Requires write access, and is authorized with the `purpose` `'delete'` (see [Authorization and `purpose`](#authorization-and-purpose)) so it can be gated more tightly than `PATCH`.

* `DELETE /api/ydoc/v1/{org}/{docid}` parameters: `{ branch?: string }`
  * `branch="main"` (default): the branch to delete. **Deletion is per branch** — deleting a document with all of its branches means deleting each of them.
  * Performs a *soft* deletion: the document stops being readable, connected WebSocket clients are disconnected, but its content is left untouched and can be brought back with [`yhub.restoreDoc`](#yhubrestoredocroom). Irreversible erasure stays out of REST — see [`yhub.deleteDoc`](#yhubdeletedocroom-opts).
  * Returns `{ deletedAt: number, hard: boolean, by: string|null }`. `deletedAt` is the unix-ms timestamp of the deletion.
  * Idempotent: deleting an already-deleted document answers `200` with the record that is already there, and the original `deletedAt` is never moved by a retry.

After a deletion every endpoint that reads the document answers `404` — `GET`/`PATCH /api/ydoc/v1`, `rollback`, `prune`, `changeset`, `activity`, and any custom endpoint that calls `yhub.getDoc`. Responses cached before the deletion are dropped as part of it, so the `404` is immediate rather than delayed by `cacheTtl`.

#### PATCH /api/ydoc/v1/{org}/{docid}

Update the Yjs document with new changes. Requires write access.

* `PATCH /api/ydoc/v1/{org}/{docid}` body: `{ update?: Uint8Array, awareness?: Uint8Array, customAttributions?: Array<{ k: string, v: string }> }` parameters: `{ branch?: string }`
  * `update`: optional Yjs update (encoded via `Y.encodeStateAsUpdate` or similar). Diffed against the current document state — only new content is applied and attributed. Attributions are automatically assigned to the authenticated user.
  * `awareness`: optional awareness update bytes — the bare output of `encodeAwarenessUpdate(awareness, clientIds)` from `@y/protocols/awareness` (no `messageAwareness` wire-format prefix). Distributed to connected clients through the same Redis channel the WebSocket path uses.
  * `customAttributions`: optional array of key-value pairs to attach as custom attributions to the `update`'s changes. Stored as `insert:<key>` / `delete:<key>` attribution attributes alongside the standard ones. Has no effect when only `awareness` is supplied.
  * `branch="main"` (default): the branch to update
  * At least one of `update` or `awareness` must be present; an empty body returns `400 Bad Request`.
  * Changes are distributed to connected WebSocket clients.
  * Returns `{ success: true, message: string }` on success.
  * The body is lib0-any-encoded by default; with `Content-Type: application/json` it is json with `update`/`awareness` as base64 strings (see [JSON encoding](#json-encoding)).

#### Example

```javascript
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

// Retrieve the current document
const getResponse = await fetch('/api/ydoc/v1/my-org/my-doc-id')
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

const patchResponse = await fetch('/api/ydoc/v1/my-org/my-doc-id', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/octet-stream' },
  body
})
```

### Rollback

Rollback all changes that match the pattern. The changes will be distributed via
websockets.

* `POST /api/rollback/v1/{org}/{docid}` body: `{ from?: number, to?: number, by?: string, contentIds?: Y.ContentIds, customAttributions?: Array<{ k: string, v: string }>, withCustomAttributions?: Array<{ k: string, v: string }> }`
  * `from`/`to`: unix timestamp range filter
  * `by=string`: comma-separated list of user-ids that matches the attributions
  * `contentIds`: Changeset that describes the changes between two versions.
  * `customAttributions`: optional array of key-value pairs to attach as custom attributions to the rollback changes themselves (the undo operation).
  * `withCustomAttributions`: optional array of key-value pairs to filter which changes to undo. Only changes whose attributions match all specified key-value pairs will be rolled back.

#### Example

* Rollback all changes that happened after timestamp `X`: `POST /api/rollback/v1/{org}/{docid}?from=X`
  * If your "versions" have timestamps, this call enables you to revert to a specific
    version of the document.
* Rollback all changes from user-id `U` that happened between timestamp `X` and `Y`: `POST /api/rollback/v1/{org}/{docid}?by=U&from=X&to=Y`
  * This call enables you to undo all changes within a certain editing-interval.
* Rollback all changes of a certain user between two versions: `POST /api/rollback/v1/{org}/{docid}` body: `{ by: userid, contentIds: Y.createContentIdsFromDocDiff(prevYDoc, nextYDoc) }`

### Changeset

Visualize attributed changes using either pure deltas or by retrieving the
before and after state of a Yjs doc. Optionally, include relevant attributions.

* `GET /api/changeset/v1/{org}/{docid}` parameters: `{ from?: number, to?: number, by?: string, ydoc?: boolean, contentIds?: Y.ContentIds, delta?: boolean, attributions?: boolean, withCustomAttributions?: string }`
  * `from`/`to`: unix timestamp range filter
  * `by=string`: comma-separated list of user-ids that matches the attributions
  * `withCustomAttributions=string`: filter by custom attributions using `key:value` pairs, comma-separated (e.g. `source:import,tag:v2`). Only changes matching all specified attributions are included.
  * `contentIds`: Changeset that describes the changes between two versions. @todo not implemented
  * `ydoc=true`: include the encoded document **as it was at `to`** — a single partially garbage-collected Yjs update. Deleted content outside the attribution window is gc'd; in-range deletes are kept restorable.
  * `delta=true`: include the delta representation — the document at `to` with the in-range attributions highlighted.
  * `attributions=true`: include the attributions `ContentMap`.
  * Returns `{ ydoc?: Uint8Array, attributions?: Y.ContentMap, delta?: Delta }`, served as `application/x-lib0any` (json on `Accept: application/json`, binary fields as base64 — see [JSON encoding](#json-encoding)).

The `ydoc` is the document at `to`; its alive content already *is* that point-in-time state, so you render its differences by applying it to a `gc: false` doc and overlaying the `attributions` with an `AttributionsRenderer` (see [Rendering with AttributionsRenderer](#rendering-with-attributionsrenderer)).

#### Example: visualize editing trail of the past day

* Retrieve activity `GET /api/activity/v1/{org}/{docid}?from={now-1day}`
* Optionally, bundle changes that belong to each other: `[1, 2, 70, 71] ⇒ [2, 71]` - because `1,2` and `70,71` belong to each other.
* For each timestamp: `GET /api/changeset/v1/{org}/{docid}?from=timestamps[I - 1]&to=timestamps[I]&delta=true&attributions=true`
* The `delta` renders the document as it was at `to`, with the changes attributed to the `[from, to]` interval highlighted.

### Activity

Retrieve all editing-timestamps for a certain document. Use
the activity API and the changeset API to reconstruct an editing trail.

* `GET /api/activity/v1/{org}/{docid}` parameters: `{ from?: number, to?: number, by?: string, limit?: number, order?: string, group?: boolean, groupMaxGap?: number, groupMaxDuration?: number, mergeUsers?: boolean, delta?: boolean, withCustomAttributions?: string, customAttributions?: boolean, contentIds?: string }`
  * `from`/`to`: unix timestamp range filter
  * `by=string`: comma-separated list of user-ids to filter by
  * `withCustomAttributions=string`: filter by custom attributions using `key:value` pairs, comma-separated (e.g. `source:import,tag:v2`). Only changes matching all specified attributions are included.
  * `contentIds=string`: base64-encoded `Y.ContentIds` binary. When provided, only activity entries whose content intersects the given content set are returned. Encode via `buffer.toBase64(Y.encodeContentIds(contentIds))` (`import * as buffer from 'lib0/buffer'`).
  * `limit=number`: maximum number of entries to return
  * `order='asc'|'desc'`: `"asc"` (oldest first) or `"desc"` (newest first, default)
  * `group=boolean`: bundle consecutive changes from the same user into a single entry (experimental)
  * `groupMaxGap=number`: maximum time gap (in milliseconds) between consecutive changes that still merges them into a single entry (default: `1000`). Only applies when grouping is enabled.
  * `groupMaxDuration=number`: maximum total span (in milliseconds) of a grouped entry (`entry.to - entry.from`). A change is not merged into a group if the resulting span would exceed this value (default: unlimited). Only applies when grouping is enabled.
  * `mergeUsers=boolean`: also bundle consecutive changes from *different* users into a single entry, so that grouping is decided purely by `groupMaxGap`/`groupMaxDuration` (default: `false`). The entry's `by` then lists every contributing user-id, comma-separated in order of first appearance — the same encoding `by=` accepts as a filter. Only applies when grouping is enabled. Useful for a "what happened to this document between 9am and 10am" timeline, where interleaved edits by several people should read as one session rather than one entry per author switch.
  * `delta=boolean`: include a delta representation for each activity entry — the document at that entry's `to`, with the entry's changes highlighted.
  * `ydoc=boolean`: return a single shared partially-gc'd document for the whole list, plus per entry a `renderedContent` IdSet (= content alive at the entry's `to`). The response shape becomes `{ ydoc, activity }`. Render any entry client-side by applying `ydoc` to a `gc: false` doc and overlaying an `AttributionsRenderer` with that entry's `renderedContent` (and `attributions`) — see [Rendering with AttributionsRenderer](#rendering-with-attributionsrenderer).
  * `attributions=boolean`: include each entry's attribution `ContentMap` (as `attributions: Uint8Array`).
  * `customAttributions=true`: include the list of custom attributions associated with each activity entry. When enabled, each entry includes a `customAttributions` field containing deduplicated `{ k, v }` pairs collected from the underlying attribution attributes (e.g. `insert:<key>`). When grouping is enabled, custom attributions from merged entries are combined and deduplicated.
  * Returns `{ activity: Array<{ from: number, to: number, by: string?, delta?: Delta, renderedContent?: Uint8Array, attributions?: Uint8Array, customAttributions?: Array<{ k: string, v: string }> }>, ydoc?: Uint8Array }`. The top-level shape is stable regardless of `ydoc`. Served as `application/x-lib0any` (json on `Accept: application/json`, binary fields as base64 — see [JSON encoding](#json-encoding)).
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

* `POST /api/prune/v1/{org}/{docid}` body: `{ from?: number, to?: number, by?: string, contentIds?: Y.ContentIds, withCustomAttributions?: Array<{ k: string, v: string }> }`
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

* Compact all churn within an editing interval: `POST /api/prune/v1/{org}/{docid}` body: `{ from: X, to: Y }`
* Compact only a specific user's churn in that interval: body: `{ from: X, to: Y, by: U }`
* Compact the **entire** document history — pass an all-encompassing range: body: `{ from: 0, to: Number.MAX_SAFE_INTEGER }`

```js
import * as buffer from 'lib0/buffer'

const prune = body => fetch(`http://${yhubHost}/api/prune/v1/${org}/${docid}`, {
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
const res = await fetch(`http://${yhubHost}/api/activity/v1/${org}/${docid}?group=false`)
const activity = buffer.decodeAny(new Uint8Array(await res.arrayBuffer()))

// merge activity entries `i..j`: prune everything that was inserted and deleted between them
await prune({ from: activity[i].from, to: activity[j].to })
```

### Custom API endpoints

Define your own rest endpoints — served from the same process and guarded by the same auth plugin
as the built-in endpoints — via the `server.api` config section. Every endpoint — built-in and
custom — lives under `/{apiPrefix}/{name}/{version}/...`. The built-in endpoints (`ydoc`,
`rollback`, `prune`, `changeset`, `activity`, plus the websocket route at `/{apiPrefix}/ws/v1/...`)
are default endpoints in the same namespace, so their names are taken at `v1`: a custom endpoint
reusing a built-in name at `v1` (same url depth) throws the duplicate-endpoint error at startup,
while a different version (e.g. `name: 'ydoc', version: 'v2'`) is free. The prefix defaults to
`api` and can be renamed via `server.apiPrefix` (e.g. `apiPrefix: 'collaboration'` serves
everything — built-ins included — under `/collaboration/{name}/{version}/...`). It must be a
single bare path segment (`^[A-Za-z0-9_-]+$`).

```js
import * as s from 'lib0/schema'
import { createYHub, createAuthPlugin, apiError } from '@y/hub'

const yhub = await createYHub({
  // ...
  server: {
    port: 8080,
    auth: createAuthPlugin({ /* see below */ }),
    api: [
      // doc scope (default) → GET/POST /api/comments/v1/{org}/{docid}
      {
        name: 'comments',
        accessPurpose: 'comments', // forwarded to getAccessType as `purpose`
        get: {
          // supported query attributes - parsed & validated before the handler runs (see below)
          $query: { limit: s.$number.optional, resolved: s.$boolean.optional },
          handler: async req => ({ comments: await readComments(req.room, req.query), viewer: req.authInfo.userid })
        },
        post: {
          handler: async req => {
            const { text } = await req.any()
            if (!text) throw apiError(400, 'text is required')
            await saveComment(req.room, req.authInfo.userid, text)
          }
        }
      },
      // item route sharing the collection's name → GET /api/comments/v1/{org}/{docid}/{commentId}
      { name: 'comments', path: '/:commentId', get: { handler: async req => await getComment(req.room, req.params.commentId) } },
      // a breaking revision of the same endpoint → GET /api/comments/v2/{org}/{docid}
      { name: 'comments', version: 'v2', get: { handler: async req => ({ comments: await readCommentsV2(req.room) }) } },
      // org scope → GET /api/docs/v1/{org}
      { name: 'docs', scope: 'org', get: { handler: async req => ({ docs: await listDocs(req.org) }) } },
      // global scope → GET /api/stats/v1
      { name: 'stats', scope: 'global', get: { handler: async req => ({ uptime: process.uptime() }) } }
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
| `scope` | `'doc' \| 'org' \| 'global'` | `'doc'` | route shape: `/api/{name}/{version}/{org}/{docid}`, `/api/{name}/{version}/{org}`, or `/api/{name}/{version}` |
| `path` | `string` | `''` | extra named path segments appended to the route, e.g. `'/:commentId'` (named params only, available via `req.params`) |
| `accessPurpose` | `string` | `null` | forwarded as `purpose` to the auth access callback (see below) |
| `cors` | `object \| null` | inherits `server.cors` | overrides the hub's CORS for this endpoint, shallow-merged over `server.cors`; `null` disables CORS on it (no cross-origin access — same-origin and non-browser clients only). See [CORS](#cors) |
| `get`, `post`, `put`, `patch`, `delete` | `{ $query?, $body?, accessPurpose?, handler }` | — | method definitions; at least one is required. `handler` is the async request handler; `$query` optionally declares the supported query attributes and `$body` (not on `get`) the request body (see below); `accessPurpose` overrides the endpoint's for this method alone. `get` requires `'r'` access, all other methods require `'rw'`. |

Because the prefix, names, and versions are single segments, every request under the api namespace
has the fixed shape `/{apiPrefix}/{apiname}/{version}/...` — easy for proxies to inspect
positionally.

#### Query attributes (`$query`)

A method's `$query` declares its supported query attributes as a shape object: each value is a
lib0 schema (`s.$number`), a literal (`'a'` ≙ `s.$literal('a')`), or an array of those
(≙ a union, e.g. `['a', 'b']`). A prebuilt `s.$object(..)` / `s.$partial(..)` schema works too
(`$partial` makes every attribute optional). Query values arrive as url strings and are coerced
against each attribute's schema via lib0's `s.coerce`: numeric strings (`Number()`-parseable,
non-empty) become numbers, `'true'`/`'false'` become booleans, literals match their string form
(`?page=2` satisfies `s.$literal(2)`), and unions/optionals are descended. Each declared attribute
is validated **before the request object is created**: a failing or missing required attribute
answers `400 { error, code: 'invalid-query' }` — `error` names the attribute, e.g.
`invalid query: [limit] "abc" doesn't match number` — without invoking the handler. Attributes
*not* declared in `$query` pass through as raw strings, and a method without `$query` receives all
values raw.

Doc-scoped endpoints may declare `branch` to constrain the requested branch (e.g.
`branch: 'main'`, a pattern, or a union like `['main', 'preview']`). Because `branch` defaults to
`'main'` server-side, the effective branch is validated when `?branch` is omitted — `branch:
'main'` accepts implicit-main requests, and `req.query.branch` always equals `req.branch`.
Undeclared `branch` passes through raw.

```js
get: {
  $query: {
    limit: s.$number.optional, // ?limit=50 → req.query.limit === 50
    resolved: s.$boolean.optional, // ?resolved=true → req.query.resolved === true
    order: ['asc', 'desc'] // required; anything but ?order=asc / ?order=desc → 400
  },
  handler: async req => { /* ... */ }
}
```

#### Request body (`$body`)

A method's `$body` declares its request body the same way — a shape object or any prebuilt
schema, e.g. `s.$array(..)` for an endpoint that takes a bare json array (`get` cannot declare
one; the registration throws at startup). When
declared, the framework awaits the body before invoking the handler, decodes it by the request's
content type — `application/json` → json, anything else → lib0-any — and passes the result as
`req.body`. Json bodies are **coerced** against the schema: json can't express all lib0-any
types, so `s.$uint8Array` fields accept base64 strings and arrive as real `Uint8Array`s. Lib0-any
bodies express exact types and are **validated only** — a string where `s.$uint8Array` is
declared is rejected, never converted. A body that fails to parse or validate answers
`400 { error, code: 'invalid-body' }` without invoking the handler.
Methods without `$body` are unaffected: `req.body` is `undefined` and the raw accessors
(`req.bytes()`, `req.any()`) remain the way to read the body.

```js
post: {
  $body: {
    text: s.$string, // required; missing or wrong type → 400
    attachment: s.$uint8Array.optional // json clients send base64, lib0 clients send bytes
  },
  handler: async req => { await saveComment(req.room, req.authInfo.userid, req.body) }
}
```

Handlers are typed by `scope`: doc-scoped handlers receive a non-null `req.room`, org-scoped
handlers receive `req.org` only, global handlers neither. Plain object literals inside `api: [...]`
get these typings automatically. For endpoints defined in separate modules (where contextual typing
can't reach), use the `createApiEndpoint` helper — it also preserves the literal endpoint name for
tooling, and types `req.query` / `req.body` by the method's `$query` / `$body` specs
(`{ [key: string]: any }` / `undefined` when there is none):

```js
import * as s from 'lib0/schema'
import { createApiEndpoint } from '@y/hub'

export const comments = createApiEndpoint('comments', {
  get: {
    $query: { limit: s.$number.optional },
    // req.room: Room (non-null), req.query.limit: number|undefined (coerced from the url string)
    handler: async req => ({ comments: await readComments(req.room, { limit: req.query.limit ?? 50 }) })
  }
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

A single method can override it, which is how a destructive method is gated more tightly than the
reads next to it — setting it on the endpoint instead would silently change the purpose that every
existing caller of the other methods is authorized against. The built-in `ydoc` endpoint does
exactly this, declaring `accessPurpose: 'delete'` on its `delete` method only:

```js
createApiEndpoint('report', {
  get: { handler: async req => renderReport(req.room) },
  delete: { accessPurpose: 'admin', handler: async req => dropReport(req.room) }
})
```

#### The request object

Handlers receive a single request object. All properties are plain snapshots — safe to access at
any time, also after `await`s:

| Property | Type | Description |
|---|---|---|
| `yhub` | `YHub` | the yhub instance — query documents via `yhub.getDoc(req.room, ...)`, access `stream`, `persistence`, `computePool`, `agentTask` |
| `method` | `string` | `'get' \| 'post' \| 'put' \| 'patch' \| 'delete'` |
| `path` | `string` | the request path, e.g. `/api/comments/v1/acme/readme` |
| `org` | `string \| null` | `null` for global scope |
| `docid`, `branch`, `room` | | only set for doc scope; `branch` from `?branch=` (default `'main'`) |
| `params` | `{ [name]: string }` | the named path segments declared via `path` |
| `query` | `{ [name]: any }` | the url query attributes as a plain object. Attributes declared in the method's `$query` are coerced & validated (and typed via `createApiEndpoint`); all others are raw strings. Repeated keys: last wins. |
| `headers` | `{ [name]: string }` | lowercased request headers |
| `authInfo` | | whatever `readAuthInfo` returned |
| `accessType` | `'r' \| 'rw'` | the granted access |
| `aborted` | `boolean` | becomes `true` when the client disconnects — check between expensive steps and return early |
| `body` | | the decoded & validated request body when the method declares `$body`; `undefined` otherwise |
| `bytes()` | `() => Promise<Uint8Array>` | the raw request body |
| `any()` | `() => Promise<any>` | the request body, lib0-any-decoded |

#### Return values

| Handler returns | Response |
|---|---|
| `Response` | status, headers, and body are taken from the `Response` — the full-control escape hatch. The configured CORS headers are added unless the `Response` sets one itself (its own `Access-Control-Allow-Origin` takes over CORS entirely — though `Vary: Origin` is still written for allowlist configs — and no header is ever emitted twice); `content-length`/`transfer-encoding` are managed by the server. |
| `undefined` / `null` | `204 No Content` |
| `string` | `200`, `text/plain; charset=utf-8` |
| `Uint8Array` / `Buffer` | `200`, `application/octet-stream`, as-is — opaque bytes, never transcoded |
| `encodedAny(bytes)` | `200`, `application/x-lib0any`, as-is — marks bytes that are *already* lib0-any-encoded (e.g. cached), so they transcode to json on request like an object result. The built-in changeset/activity endpoints respond this way. `encodedAny` is exported by `@y/hub`. |
| anything else | `200`, `application/x-lib0any`, lib0-any-encoded — the same encoding all built-in endpoints use. The dedicated content type keeps the wire self-describing: clients decode by content type (`x-lib0any` → `decodeAny`, `text/*` → text, else raw bytes). Served as `application/json` instead when the request sent `Accept: application/json` (see [JSON encoding](#json-encoding)). |

Throw `apiError(status, message, extra?)` (exported by `@y/hub`) to respond with a specific status
code and an any-encoded `{ error: message, ...extra }` body (json on `Accept: application/json`) —
use `extra` for machine-readable fields, conventionally `{ code: 'comment-not-found' }`. Any other
exception is logged and produces a generic `500` without leaking internals.

Pick the status by retry class (see [Errors](#errors)): `4xx` when the caller must change
something first — the request (`400`/`422`), the target (`404`), the conflict (`409`) — `503`
(or another `5xx`) when a dependency of your handler is temporarily down, and `429` when you
rate-limit. Clients retry `5xx` and `429` and treat everything else as permanent — don't hide a
transient failure behind a `4xx`.

```js
import * as buffer from 'lib0/buffer'

// call a custom endpoint
const res = await fetch(`http://${yhubHost}/api/comments/v1/${org}/${docid}`)
const { comments } = buffer.decodeAny(new Uint8Array(await res.arrayBuffer()))
```

### CORS

Browsers may only call the api from a page whose origin the server allows. **Until
`server.cors` is configured, cross-origin browser access is closed**: no `Access-Control-*`
header is sent, so responses stay unreadable, and WebSocket upgrades and api requests
carrying a cross-origin `Origin` are rejected with `403`. Same-origin pages work with zero
configuration (see [Same-origin requests](#same-origin-requests)), and non-browser clients
(node, server-to-server, curl) are never restricted — they send no `Origin` header; the auth
plugin gates those.

```js
server: {
  cors: {
    origin: ['https://app.example.com', 'https://admin.example.com'],
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['x-request-id'],
    maxAge: 7200
  }
}
```

`Access-Control-Allow-Origin` holds a single value, so serving several origins works by echoing
back the one that matched. yhub therefore sends `Vary: Origin` automatically whenever `origin`
is anything but `'*'` (a single origin is a one-entry allowlist) — without it a cache or CDN in
front of yhub would serve one origin's response to another. The same applies while CORS is not
configured at all (or disabled on an endpoint): no `Access-Control-*` header is ever written,
but the origin gate still answers the same url `200` same-origin and `403` cross-origin, so
`Vary: Origin` is sent there too. A request from an origin that does
not match is rejected with `403 { error: 'origin not allowed', code: 'origin-not-allowed' }` —
always json, a browser is by definition on the other end (see below); the rejection carries
`Vary: Origin` but no
`Access-Control-*` header — nothing about the response is readable.

An allowlist entry may start its host with `*.`: `https://*.example.com` matches every host
under `example.com` — subdomains of subdomains included — but never `https://example.com`
itself (list the apex separately) and never another port (spell ports out, e.g.
`https://*.example.com:8443`). The `.` after the star pins the suffix to a domain boundary, so
a wildcard can only ever match hosts under the domain it names.
Warning: `https://*.github.io`, or `https://*.vercel.app` are accepted and allowlist every site anyone
can host under the suffix — just as open as `*.com`. Only wildcard a domain you own outright,
and mind the blast radius under `credentials: true`: a compromise of *any* host under the
suffix — say, one preview deploy — yields credentialed api access.

Only the headers that apply to a given response are sent: `Allow-Methods`, `Allow-Headers` and
`Max-Age` on preflights, `Expose-Headers` on real responses, `Allow-Origin` and
`Allow-Credentials` on both. `Allow-Methods` lists exactly the methods that endpoint registers
(a plain `Allow` header carries the same list, per RFC 9110). `allowHeaders` defaults to
`['Content-Type', 'Authorization']` — the built-in api authenticates via `Authorization`, which
always preflights — and `maxAge` defaults to `3600`. Preflight routes exist only where CORS
does: an endpoint with CORS disabled, and any unregistered path, answers `OPTIONS` with the
default `404`.

Setting `allowHeaders` **replaces** the default — re-list `Content-Type` and `Authorization`
alongside your own headers, or authorized browser requests fail at the preflight. Browser
tracing SDKs are the usual reason to extend it: OpenTelemetry adds `traceparent`/`tracestate`
and Sentry adds `sentry-trace`/`baggage` to instrumented fetches, and neither passes the
default list. To allow every request header, write `allowHeaders: ['*', 'Authorization']` —
the Fetch wildcard never covers `Authorization`, so a bare `['*']` is refused at startup, and
credentialed configs must enumerate their headers (browsers read `*` literally then).

`CORS_ORIGIN` sets `origin` for the packaged CLI and docker image (comma-separated for an
allowlist). While it is unset, `server.cors` stays unset — same-origin pages and non-browser
clients only; `CORS_ORIGIN='*'` opens the api to every origin and logs a warning.

#### Per-endpoint overrides

A custom endpoint may override the hub's CORS via its `cors` field, shallow-merged over
`server.cors`. Use it to open one endpoint to everybody, or to close one off:

```js
createApiEndpoint('public-stats', { cors: { origin: '*' }, get: { handler } })
createApiEndpoint('admin', { cors: null, post: { handler } })
```

`cors: null` means no cross-origin access: no `Access-Control-*` header is ever written, no
preflight route is registered, and cross-origin requests are rejected — the endpoint serves
same-origin pages and non-browser clients only. Note that `null` means *as if `server.cors`
were unset*, not "most restrictive": an endpoint opting out under a hub with
`trustSameOrigin: false` regains the implicit same-origin trust. The WebSocket route and the
built-in endpoints always follow `server.cors` — only custom endpoints can override it.

Each endpoint's *merged* config is validated at startup: the `'*'`/`credentials` rule — browsers
reject the pair, so an endpoint opening itself to every origin under a hub with
`credentials: true` must disable them explicitly, `cors: { origin: '*', credentials: false }` —
plus field-by-field checks, so a typoed field or a stringly value in an override throws instead
of being silently ignored (`cors: false` is refused too — only `null` disables). Every such
startup error names the endpoint at fault.

Preflights are answered from the configured CORS alone — a handler `Response` that takes over
`Access-Control-Allow-Origin` affects only real responses, never its route's preflight.

#### Where CORS alone is not enough

Browsers do not apply CORS to WebSocket connections: any page can open one regardless of what
`Access-Control-Allow-Origin` says. And they send "simple" requests — e.g. a `text/plain` POST —
*without* a preflight; CORS only hides the response, but the request still reaches the server
carrying the visitor's cookies, and its timing stays observable. yhub closes these gaps itself:
a WebSocket upgrade or an api request — GET included — is rejected with `403` unless its
`Origin` is allowed by the cors config or same-origin, **also while `server.cors` is entirely
unset**. Denying a GET the browser would hide anyway costs nothing legitimate, and it keeps
response timing unobservable and expensive reads untriggerable cross-site. A request with no
`Origin` header (node clients, server-to-server, `<img>`/`<script>` embeds) is never
restricted; the auth plugin gates those. The gate follows Go 1.25's stdlib
`http.CrossOriginProtection`: `Sec-Fetch-Site` is consulted when a browser sends it (see
[Same-origin requests](#same-origin-requests)), the `Origin`/`Host` comparison is the fallback —
though yhub is stricter in gating GET, and never restricts requests without an `Origin` header
(browsers attach `Origin` to every cross-site request the gate is for).

#### Same-origin requests

A request whose `Origin` names the request's own `Host` (`host[:port]`, compared
case-insensitively) is same-origin: it passes the gate without being listed, so an app served
from the same host as yhub works with no cors configuration at all — same-origin responses need
no `Access-Control-*` header either. The scheme is deliberately not compared: behind a
TLS-terminating proxy yhub sees plain http while the browser's `Origin` says `https://…`. A
proxy that rewrites `Host` fails the comparison *closed* — list your origin in `cors.origin`
explicitly then. A browser that sends `Sec-Fetch-Site` (all of them since 2023) must also
report `same-origin` (or `none`) for the implicit trust to apply — an http page targeting the
https api reports `cross-site` and is denied, closing the scheme gap the comparison cannot
see, while an https page behind the TLS-terminating proxy still reports `same-origin` (the
header travels through untouched). The allowlist is unaffected either way, and requests
without the header fall back to the comparison alone. Set `trustSameOrigin: false` to drop the
implicit trust and enforce the
allowlist for every browser origin, same-origin included.

#### Origins are fixed at startup

The allowlist is resolved once at startup: there is no per-request origin callback and no
reload — adding an origin means a restart. Platforms where third parties share one apex
(Vercel-style `myapp-git-branch.vercel.app` previews) cannot be wildcarded safely: the
partial-prefix form `https://myapp-*.vercel.app` is refused at startup, and
`https://*.vercel.app` would allowlist every tenant on the platform. List such deploys
explicitly, or front yhub with a proxy that
authenticates the deployment itself and strips the `Origin` header (requests without an
`Origin` pass the gate; the auth plugin gates them like any other non-browser client).

#### Apps without a listable origin

Capacitor/Ionic apps (`capacitor://localhost`) and browser extensions
(`chrome-extension://<id>`) have perfectly listable origins — extensions must be listed even
though `host_permissions` bypasses CORS in-browser, because the origin gate still checks them.
Electron/webview apps loading from `file://` send `Origin: null`, which is never allowlistable
(`'null'` is also the origin of every sandboxed iframe on the internet) — such apps control
their network stack and should strip or replace the `Origin` header instead. An iframe widget
needs only the widget's own origin listed, whatever site embeds it: requests from inside the
iframe carry the widget's origin, not the embedder's.

#### What CORS does and does not protect

CORS is not an authorization mechanism. `origin: '*'` does not expose data the auth plugin would
refuse, because an attacker's server can call the api directly regardless — the auth plugin is
what protects your data. What an allowlist does prevent is a page on another origin using a
visitor's browser to call the api. That only becomes a real escalation together with
`credentials: true`, which is why `'*'` and `credentials` cannot be combined. The same applies to
any auth plugin that reads ambient credentials (cookies, http auth): pair it with an origin
allowlist — with `'*'`, any page on the internet can open a WebSocket or fire a simple POST in
the visitor's session.

Cookie-authenticated cross-site deployments have two more browser rules to satisfy, neither of
them CORS-shaped: session cookies must be `SameSite=None; Secure`, or the browser silently
withholds them from cross-site fetches *and* from the WebSocket handshake — the symptom is a
`401` from the auth plugin, not a CORS error. And browsers cannot attach an `Authorization`
header to a WebSocket: token-auth clients pass the token via the url or
`Sec-WebSocket-Protocol` for `readAuthInfo` to pick up.

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
| `redis.taskDebounce` | `number` | no | Milliseconds before a worker picks up a compaction task. Also the lease timeout after which a task held by a crashed worker is reclaimed — a worker renews the lease of the tasks it is running, so this does not have to exceed the compaction time. Default: 120 000 |
| `redis.minMessageLifetime` | `number` | no | Minimum time in ms that update messages are kept in Redis streams before compaction. Default: 60 000 |
| `redis.cacheTtl` | `number` | no | TTL in seconds for cached API responses. Default: 10 |
| `redis.clientOptions` | `object` | no | Additional options passed to the node-redis client, e.g. `{ pingInterval: 10000 }`. YHub still controls `url`; `redis.socket` is merged into the final socket config; `clientOptions.scripts` are merged with YHub's Lua scripts. |
| `redis.socket` | `object` | no | Custom socket options merged into the Redis client socket config. See [node-redis socket options](https://github.com/redis/node-redis/blob/master/docs/client-configuration.md#socket-options) for available options. |
| `postgres` | `string` | yes | PostgreSQL connection string |
| `persistence` | `PersistencePlugin[]` | yes | One or more storage plugins (e.g. `S3PersistenceV1`). At least one is required. |
| `maxTaskDuration` | `number` | no | Milliseconds a single task may run. A compute task that exceeds it has its worker thread killed (compute can't be cancelled cooperatively), which rejects the task so its caller can retry. A compaction task that exceeds it outside of compute — a wedged S3 or PostgreSQL socket — is abandoned by the worker so its room is reclaimed by another worker instead of staying leased forever. Default: 1 800 000 (30 minutes) |
| `computePoolSize` | `number` | no | Worker threads in the compute pool for CPU-intensive Yjs work (merging, state vectors, changesets). Default: number of cpus - 1. Set this explicitly when the process is restricted to a subset of cores — `os.cpus().length` does not reflect `taskset` or cgroup limits. |
| `server` | `object \| null` | no | HTTP/WebSocket server config. Set to `null` to run without a server (worker/script mode). |
| `server.port` | `number` | yes* | Port to listen on |
| `server.auth` | `AuthPlugin` | yes* | Auth plugin created with `createAuthPlugin`. `getAccessType(authInfo, room, purpose)` receives the `accessPurpose` of custom api endpoints as `purpose` (null-ish otherwise). The optional `getOrgAccessType(authInfo, org, purpose)` / `getGlobalAccessType(authInfo, purpose)` callbacks authorize org-/global-scoped custom endpoints — when missing, endpoints of that scope deny all access. |
| `server.api` | `ApiSpec[]` | no | Custom rest endpoints served under `/{apiPrefix}/{name}/{version}/...`, next to the built-in ones. See [Custom API endpoints](#custom-api-endpoints). |
| `server.apiPrefix` | `string` | no | First path segment under which all endpoints are served — built-in and custom rest endpoints plus the websocket route `/{apiPrefix}/ws/v1/...` — e.g. `'collaboration'` → `/collaboration/{name}/{version}/...`. A single path segment. Default: `'api'` |
| `server.maxDocSize` | `number` | no | Maximum Ydoc size in bytes, used for WebSocket payload limits. Default: 500 MB |
| `server.cors` | `object \| null` | no | Cross-origin resource sharing — see [CORS](#cors). **While this is unset, cross-origin browser access is closed**: no `Access-Control-*` header is sent, and cross-origin WebSocket upgrades and api requests are denied. Same-origin pages and non-browser clients are unaffected. |
| `server.cors.origin` | `string \| string[]` | yes* | `'*'` for every origin, one origin, or an allowlist. An allowlist echoes back the request's `Origin` when it matches and sends `Vary: Origin`; a request from a non-matching origin is denied. An entry may start its host with `*.` — `https://*.example.com` matches every host under `example.com` but never the apex, and ports must be spelled out. Only wildcard a domain you own outright: `https://*.co.uk`-style public-suffix wildcards are accepted but allowlist every site under the suffix. |
| `server.cors.credentials` | `boolean` | no | Send `Access-Control-Allow-Credentials: true`, letting browsers send cookies and http auth. Requires a concrete `origin` — `'*'` together with `credentials` throws at startup, because browsers reject the pair. Default: `false` |
| `server.cors.trustSameOrigin` | `boolean` | no | Trust browser requests whose `Origin` names the request's own `Host`: they pass the origin gate without being listed — the scheme is not compared, so TLS-terminating proxies keep working, but a browser that sends `Sec-Fetch-Site` must also report `same-origin`/`none`, which closes the scheme gap. Set `false` to enforce the allowlist for every browser origin, same-origin included. Affects only the origin gate on WebSocket upgrades and api requests. Default: `true` |
| `server.cors.allowHeaders` | `string[]` | no | `Access-Control-Allow-Headers` on the preflight. Setting it **replaces** the default, so re-list `Content-Type` and `Authorization` alongside your own headers. `['*', 'Authorization']` allows everything — the Fetch wildcard never covers `Authorization`, so a bare `['*']` throws at startup. Default: `['Content-Type', 'Authorization']` — `Authorization` is never a "simple" header, so every authorized browser request preflights and would fail without it. |
| `server.cors.exposeHeaders` | `string[]` | no | `Access-Control-Expose-Headers` — response headers browser code may read. |
| `server.cors.maxAge` | `number` | no | `Access-Control-Max-Age` in seconds (a non-negative integer; browsers cap it, e.g. Chrome at `7200`). Default: `3600` |
| `worker` | `object \| null` | no | Background compaction worker config. Set to `null` to disable. |
| `worker.taskConcurrency` | `number` | yes* | Maximum number of compaction tasks to process in parallel |
| `worker.events.docUpdate` | `function` | no | Called after each compaction with the merged `DocTable` plus the `room` it belongs to |

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

`tombstone` is always returned — `null` for a document that was never deleted — and is read in the same statement as the document, so it costs no extra round trip.

**`getDoc` does not refuse a deleted document; it reports one.** Deciding what that means belongs to the caller: the built-in endpoints throw `DocDeletedError` (exported from `@y/hub`), which `registerApi` answers with `404 { code: 'doc-deleted' }`; the WebSocket path closes with `4404`; the compact worker carries on, because it still has to trim the stream. A custom endpoint that reads a document is in the same position and should do the same:

```js
const { gcDoc, tombstone } = await req.yhub.getDoc(req.room, { gc: true })
if (tombstone != null) throw new DocDeletedError(req.room, tombstone)
```

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
compaction. This is the programmatic equivalent of `POST /api/prune/v1/{org}/{docid}`.

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
access level; a still-revoked client is rejected with `403 Forbidden` at upgrade). A failing auth
plugin fails closed: the connection is disconnected, but with the transient close code `1013`
(`'auth recheck failed'`) — clients keep reconnecting and recover once the auth backend does.

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

**Client handling.** `4401` is a permanent close code — stop auto-reconnecting and re-authenticate
(rule and snippet under [Errors](#errors)). `@y/websocket` reconnects indefinitely by default:
without that handler a kicked, still-revoked client retries every ≤2.5s, hitting your auth backend
with a `403` each time.

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
  post: { handler: async req => { await req.yhub.recheckAuth(req.room, await req.any()) } }
})
```

> **Rolling upgrades:** servers and workers running a version older than this feature fail reading
> a room stream that contains an `auth:check:v1` entry (for up to `minMessageLifetime`). Deploy the
> new version to all processes before the first `recheckAuth` call.

#### `yhub.deleteDoc(room, opts?)`

Delete a document. **Deletion is per branch** — deleting a document with all of its branches means
deleting each of them. Deleting a whole document or a whole organization at once is not supported yet.

```ts
yhub.deleteDoc(
  room: { org: string, docid: string, branch: string },
  opts?: { hard?: boolean, by?: string | null }  // default: { hard: false, by: null }
): Promise<{ org, docid, branch, deletedAt: number, hard: boolean, purgedAt: number|null, by: string|null }>
```

A **soft** deletion (the default) only records that the document is gone. Reads report it as deleted,
connected clients are disconnected, but its rows and S3 objects are left alone and **compaction
keeps running** — so updates that were still on the Redis stream are persisted rather than trimmed
away unpersisted, and [`restoreDoc`](#yhubrestoredocroom) brings the document back with its full
history. Erasing the content later is left to a retention task built on
[`getTombstones`](#yhubgettombstonesorg-filters) — see [Retention](#retention).

A **hard** deletion additionally clears the stream and erases every row and asset immediately, and
cannot be undone. Compaction never persists a hard-deleted room again — the barrier lives inside
the `INSERT` itself, so it also catches a compaction that was already merging when the deletion
landed, and `unsafePersistDoc`, which bypasses both stream and API.

Idempotent: a repeated deletion keeps the original `deletedAt` (a retry must not extend a
retention window), and a soft deletion can be upgraded to a hard one, never the reverse. Re-running
a hard deletion re-runs the purge, which is how a compaction that was still in flight the first
time gets cleaned up.

`hard` is deliberately not reachable over REST. `purpose` is advisory — an auth plugin that ignores
it grants deletion to everyone who can write — so irreversible erasure stays programmatic, like
`recheckAuth`.

**What "hard delete" guarantees.** The document becomes unrecoverable *through the API*, and objects
referenced by persistence plugins are handed to them for deletion. It is not a guarantee that every byte
has already left the store — plugins may defer (`S3PersistenceV1` does, to let concurrent readers
finish) — nor that every byte is reachable to begin with: `S3PersistenceV1`
only offloads the `main` branch, so other branches' blobs live inline in `yhub_ydoc_v1` — a deleted
row survives until autovacuum and lives on in WAL, replicas, and any earlier base backup.

**Writes after a deletion** are not rejected at the Redis layer: a client that has not noticed yet can
still push updates onto the stream. They are never persisted for a hard-deleted room, and are trimmed
away with the rest of the stream.

**Client handling.** Connected clients are disconnected with close code `4404`
(`'document deleted'`, exported as `wsCloseDocDeleted`) — permanent, so the band rule under
[Errors](#errors) already stops the reconnect loop. A deleted document additionally warrants
dropping the local copy, which no generic handler can do for you:

```js
provider.on('connection-close', event => {
  if (event?.code === 4404) indexeddbProvider.clearData()
})
```

Without that, a local copy in IndexedDB outlives the deletion and re-syncs into any document later
created under the same docid.

#### `yhub.restoreDoc(room)`

Undo a soft deletion, making the document readable again. Its content was never touched, so it comes
back with its full history. Refuses a hard deletion, and a soft one whose content was already purged
— in both cases dropping the record would resurrect a partial document, since `getDoc` merges every
row it finds and a straggling compaction may have left some behind. Restoring a document that was
never deleted is a no-op.

#### `yhub.getTombstones(org, filters?)`

```ts
yhub.getTombstones(
  org: string,
  filters?: { purged?: boolean, before?: number }
): Promise<Array<{ org, docid, branch, deletedAt: number, hard: boolean, purgedAt: number|null, by: string|null }>>
```

The deletions recorded for `org`. `purged: false` selects the documents whose content still exists,
and `before` bounds `deletedAt` (unix ms).

#### Retention

y/hub ships no retention sweeper; deciding when a soft-deleted document is due is up to the
integrator. A daily task is the whole of it:

```js
const RETENTION = 30 * 24 * 60 * 60 * 1000
const due = await yhub.getTombstones(org, { purged: false, before: Date.now() - RETENTION })
for (const doc of due) {
  await yhub.deleteDoc(doc, { hard: true })   // upgrades the deletion and erases the content
}
```

Erasing content is deliberately not a verb of its own. It is only safe once `hard` is set — that is
what arms the barrier in `Persistence.store` against a compaction still in flight — so purging a
merely soft-deleted document would let a straggler write its rows straight back. Hard-deleting an
already-soft-deleted document keeps the original `deletedAt`, so a sweep does not restart anyone's
retention window, and re-running it over a document it already handled is a no-op.

`purgedAt` records that the document's rows are gone and its assets have been handed to the
persistence plugins for deletion — not that every byte has already left the store, since a plugin
may defer (`S3PersistenceV1` does, to let concurrent readers finish). Rows are always dropped before
the assets they point at, so an interrupted purge leaves an orphaned object, never a reference to a
missing one.

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
* `author` flows into the standard `insert` / `delete` content attributions, the same way the authenticated user-id does on the WS and REST paths. `customAttributions` entries become `insert:${k}` / `delete:${k}` attributions, matching the `customAttributions` shape accepted by `PATCH /api/ydoc/v1` and the WebSocket query param. `promptBy` is sugar for one such entry and is merged with any explicit `customAttributions`.
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
