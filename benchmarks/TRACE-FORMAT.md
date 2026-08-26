# `custom-trace.anyenc` — incremental editing trace

A replayable, per-edit sequence of Yjs updates: one real document plus the individual
edits that produced it, in order, each tagged with who made it and when. `Y7` in this
benchmark suite replays it to measure apply-update throughput, incremental sync,
propagation and compaction against a workload nobody designed to be convenient.

Drop a trace at `benchmarks/custom-trace.anyenc` and `Y7` runs; without one it skips
itself and the rest of the suite is unaffected.

> **The trace file is gitignored and must stay that way — it contains real document
> content.** This format document is checked in so a trace can be produced without one
> to copy from.

- **Encoding:** a single [`lib0`](https://github.com/dmonad/lib0) `encoding.writeAny` value
- **Updates:** Yjs **v1** (`Y.applyUpdate` / `Y.encodeStateAsUpdate`, not V2)
- **Versions:** produce it with the versions yhub uses — `@y/y@14`, `lib0@1`.
  `@y/y` (Yjs v14) is **not** wire-compatible with `yjs@13` for these updates.

## Decoding

```js
import * as fs from 'node:fs'
import * as decoding from 'lib0/decoding'
import * as Y from '@y/y'

const trace = decoding.readAny(decoding.createDecoder(new Uint8Array(fs.readFileSync('custom-trace.anyenc'))))

const ydoc = new Y.Doc({ gc: trace.gc })   // gc: false — the trace preserves deleted content
for (const u of trace.updates) {
  Y.applyUpdate(ydoc, u.update)
}
```

`benchmarks/src/trace.js` is the suite's loader; `splitTrace()` returns the baseline
update and the incremental edits separately, which is usually what you want.

## Structure

```
{
  type:         'yhub:editing-trace:v1',
  updateFormat: 'yjs-v1',       // Y.applyUpdate / Y.encodeStateAsUpdate (not V2)
  gc:           false,          // updates were carved from the non-gc doc
  source: {
    documentId, org, docid, branch,
    exportedAt                  // ISO string, when the trace was built
  },
  users:      [ string ],       // distinct authors, in first-edit order
  totalBytes: number,           // sum of all update byte lengths
  updates: [                    // chronological, apply in array order
    {
      update: Uint8Array,       // a Yjs v1 update
      time:   number,           // ms epoch, when the edit happened
      user:   string,           // whatever your auth plugin puts in `userid`
      kind:   'insert' | 'delete' | 'mixed',
      ranges: number            // how many attributed id-ranges this step covers
    }
  ]
}
```

A document that was bulk-imported and then edited by hand typically has a very large
update `0` (the import) and many tiny ones after it. For benchmarks that care about
incremental work, load update `0` as the baseline and treat `updates.slice(1)` as the
workload — that is exactly what `splitTrace()` gives you.

---

# Creating your own trace

## Where the edit history comes from

You do not need to have recorded anything in advance. **yhub already stores the edit
history as attributions**, and a trace is that history turned back into updates.

For every inbound update, the server derives the id-ranges it touched and writes an
attribution for each (`createContentMapFromParams`, `src/server.js:23-31`):

| side | attributes yhub writes |
|---|---|
| inserted ranges | `insert` = userid, `insertAt` = ms epoch, plus `insert:<k>` for each custom attribution |
| deleted ranges | `delete` = userid, `deleteAt` = ms epoch, plus `delete:<k>` for each custom attribution |

These live in the **contentmap**, persisted next to the document. Decoded, it is:

```js
const contentMap = Y.decodeContentMap(bin)   // { inserts: IdMap, deletes: IdMap }

contentMap.inserts.forEach((range, client) => {
  // range = { clock: number, len: number, attrs: Array<{ name: string, val: any }> }
  // e.g. attrs = [ { name: 'insert', val: 'user_42' }, { name: 'insertAt', val: 1700000001000 } ]
})
```

So the document knows, for every struct in it, **who wrote it and at what millisecond**.
Grouping by `(user, timestamp)` recovers the individual editing steps, and each group can
be carved back out of the full update.

## The algorithm

1. **Read the non-gc document and its contentmap.** It must be the *non-gc* document —
   the trace has to reproduce deleted content, and a gc'd document no longer contains it.
2. **Enumerate the steps.** Walk both `IdMap`s and collect the distinct `(user, time)`
   pairs from `insert`/`insertAt` and `delete`/`deleteAt`. One pair is one editing step;
   a step that both inserts and deletes at the same instant was a single transaction —
   overwriting a cell, for example.
3. **Carve each step.** Filter the contentmap down to just that step's ranges, convert to
   an `IdSet` pair, and intersect the full update with it:

   ```js
   const stepMap = Y.filterContentMap(
     contentMap,
     attrs => attr(attrs, 'insert') === user && attr(attrs, 'insertAt') === time,
     attrs => attr(attrs, 'delete') === user && attr(attrs, 'deleteAt') === time
   )
   const contentIds = Y.createContentIdsFromContentMap(stepMap)
   const update = Y.intersectUpdateWithContentIds(fullUpdate, contentIds)
   ```

   `intersectUpdateWithContentIds` extracts exactly those structs and delete-set entries
   from the full document update — no document is rebuilt and no content is invented.
4. **Sort by timestamp**, then **verify**: replaying every carved update into a fresh
   `Y.Doc({ gc: false })` must produce a byte-identical `encodeStateAsUpdate` to the
   original. If it does not, the trace is a plausible-looking fiction — throw it away
   rather than benchmark against it.

## Option A — from a live yhub deployment (easiest)

[`tools/build-trace.js`](./tools/build-trace.js) does all of the above:

```sh
cd benchmarks
node --max-old-space-size=8192 \
  --env-file-if-exists=../.env \
  tools/build-trace.js --org <org> --docid <docid> [--branch main] \
                       [--bucket <s3-bucket>] [--redis-prefix <prefix>] \
                       [--out custom-trace.anyenc]
```

It connects with `server: null, worker: null` — a read-only hub that touches nothing —
calls `getDoc(docRef, { nongc: true, contentmap: true })`, reconstructs, verifies, and
writes. It refuses to write an unverified trace, and it tells you if the document is
empty or unattributed rather than emitting a silently useless file.

Point `--bucket` and `--redis-prefix` at the deployment you mean. Reading the wrong
bucket looks exactly like an empty document.

## Option B — from a yhub export

If you have an export rather than database access, the same two inputs are in it:

| file | any-decoded value |
|---|---|
| `storage_assets/id:ydoc:v1_…_0_…` | `{ type: 'asset:ydoc:v1', update }` — **non-gc** document (the `0` is the gc flag) |
| `storage_assets/id:ydoc:v1_…_1_…` | the gc'd document — *not* what you want |
| `storage_assets/id:contentmap:v1_…` | `{ type: 'asset:contentmap:v1', contentmap }` → `Y.decodeContentMap` |
| `postgres_gc.bin`, `postgres_non_gc.bin` | `{ type: 'asset:retrievable:v1', plugin: … }` — pointers only; the payload is in `storage_assets/` |

`assetIdToString` encodes the gc flag as `${gc ? 1 : 0}`, hence `…/main/0/…` for non-gc.
Decode both with `lib0/decoding.readAny`, then follow the algorithm above from step 2 —
the rest of `build-trace.js` applies unchanged.

## Things that will bite you

- **No attributions, no trace.** yhub only attributes writes it received itself. Content
  loaded with `unsafePersistDoc`, or written before attribution existed, carries none —
  `build-trace.js` will tell you the document has content but no history.
- **Clock ordering.** A step must not depend on structs that arrive later. Sorting by
  timestamp is normally enough; the verification step in 4 is what actually proves it.
- **Timestamp granularity.** Two edits by the same user in the same millisecond collapse
  into one step. That is usually correct — it was one transaction — but it does mean the
  step count is a lower bound on the number of user actions.
- **Privacy.** The trace contains the document's real content, and `user` values are
  whatever your auth plugin puts in `userid`. Treat it as production data: it is
  gitignored here, and it should not leave wherever you are entitled to keep it.
