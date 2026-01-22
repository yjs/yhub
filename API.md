# Y/hub API Documentation

Y/hub is a collaborative document backend built on Yjs. It implements the standard y-websocket protocol and extends it with attribution, history management, and selective undo/redo capabilities.

All endpoints require an `auth-cookie` which will be check via the PERM
CALLBACK.

It is assumed that all documents can be identified by a unique `{guid}`.
Furthermore, all "body" content is encoded via lib0/encoding's
`encodeAny`. All binary data in parameters is encoded via base64.

## WebSocket

The standard WebSocket backend that is compatible with y-websocket, and TipTapProvider.

For each Yjs document, there is always a gc'd version, and a non-gc'd version.
Optionally, you may fork the document to a branch, which users can use for
implementing suggestions. Branched documents have a gc'd version and a non-gc'd
version as well.

* `ws://{host}/ws/{guid}` parameters: `{ gc?: boolean, branch?: string }`
  * `gc=true` (default): standard garbage-collected document
  * `gc=false`: full document history which can be used to reconstruct editing history.
  * `branch="main"`: (default) The default branch-name if not specified otherwise.
  * `branch=string`: Optionally, define a custom branch. Changes won't be automatically synced with other branches.

## Rollback

Rollback all changes that match the pattern. The changes will be distributed via
websockets.

* `POST /rollback/{guid}` body: `{ from?: number, to?: number, by?: string, contentIds: Y.ContentIds }`
  * `from`/`to`: unix timestamp range filter
  * `by=string`: comma-separated list of user-ids that matches the attributions
  * `contentIds`: Changeset that describes the changes between two versions.

### Example

* Rollback all changes that happened after timestamp `X`: `POST /rollback/{doc-guid}?from=X`
  * If your "versions" have timestamps, this call enables you to revert to a specific
    version of the document.
* Rollback all changes from user-id `U` that happened between timestamp `X` and `Y`: `POST /rollback/{doc-guid}?by=U&from=X&to=Y`
  * This call enables you to undo all changes within a certain editing-interval.
* Rollback all changes of a certain user between two versions: `POST /rollback/{guid}` body: `{ by: userid, contentIds: Y.createContentIdsFromDocDiff(prevYDoc, nextYDoc) }`

## Changeset

Visualize attributed changes using either pure deltas or by retrieving the
before and after state of a Yjs doc. Optionally, include relevant attributions.

* `GET /changeset/{guid}` parameters: `{ from?: number, to?: number, by?: string, ydoc?: boolean, contentIds?: Y.ContentIds, delta?: boolean, attributions?: boolean }`
  * `from`/`to`: unix timestamp range filter
  * `by=string`: comma-separated list of user-ids that matches the attributions
  * `contentIds`: Changeset that describes the changes between two versions. @todo not implemented
  * `ydoc=true`: include encoded Yjs docs
  * `delta=true`: include delta representation
  * `attributions=true`: include attributions
  * Returns `{ prevDoc?: Y.Doc, nextDoc?: Y.Doc, attributions?: Y.ContentMap, delta?: Delta }` - currently returns only the ydoc.get()-delta.

### Example: visualize editing trail of the past day

* Retrieve activity `GET /activity/{guid}?from={now-1day}`
* Optionally, bundle changes that belong to each other: `[1, 2, 70, 71] ⇒ [2, 71]` - because `1,2` and `70,71` belong to each other.
* For each timestamp: `GET /changeset/{guid}?from=timestamps[I - 1]&to=timestamps[I]&delta=true&attributions=true`
* Which will give you the state of the document at timestamp `from`: `deltaState` and the (attributed) diff that is needed to get to timestamp `to`: `diff`.

## Activity

Retrieve all editing-timestamps for a certain document. Use
the activity API and the changeset API to reconstruct an editing trail.

* `GET /activity/{guid}` parameters: `{ from?: number, to?: number, limit?: number, order?: string, group?: boolean, delta?: boolean }`
  * `from`/`to`: unix timestamp range filter
  * `limit=number`: maximum number of entries to return
  * `order='asc'|'desc'`: `"asc"` (oldest first) or `"desc"` (newest first, default)
  * `group=boolean`: bundle consecutive changes from the same user into a single entry (experimental)
  * `delta=boolean`: include delta representation for each activity entry
  * Returns `Array<{ from: number, to: number, by: string?, delta?: Delta }>`

## Webhooks

Webhooks are configured using environment variables.

* `YDOC_UPDATE_CALLBACK=http://localhost:5173/ydoc` body: `encoded ydoc` - Called whenever the Yjs document was updated (after a debounce)
* `YDOC_CHANGE_CALLBACK=http://localhost:5173/ydoc` body: `{ ydoc: v2 encoded ydoc, delta: delta describing all changes }` - Called whenever the Yjs document was updated (after a debounce). 
* `AUTH_PERM_CALLBACK=http://localhost:5173/auth/perm` - Called to check Authentication of a client.

