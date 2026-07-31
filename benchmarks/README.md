# Benchmarking y/hub

> **Measurements live in [RESULTS.md](./RESULTS.md).** This document is the
> design: what we measure and why. Every number *here* is either a constant read
> out of the source or a prediction explicitly marked as one — the tier grades in
> section B are predictions from reading the code, and `RESULTS.md` reports
> whether each one was confirmed or refuted.

## How to run

```bash
npm install              # in the repo root — the suite has no deps of its own
npm run start:dbs        # in the repo root — Redis, PostgreSQL, MinIO
npm run start:init       # in the repo root — create tables and buckets

cd benchmarks
npm start                # everything, at the scale set in src/config.js
npm start -- y1          # one group (Y1 needs no databases at all)
npm start -- y2.4 y5     # any mix of group and benchmark ids
```

Results are printed as they complete and written to `benchmarks/RESULTS.md`.
`Y1` takes seconds; a full run takes tens of minutes, most of it in `Y5` and `Y6`
where documents are grown and compacted repeatedly. The first run also generates
the fixture documents — `npm run fixtures` does that separately if you would
rather not pay it inside a timed run.

**[`src/config.js`](./src/config.js) is the only file you need to edit.** Every
parameter lives there: database URLs, sweep ranges, document sizes, connection
counts, durations, `taskDebounce`, `taskConcurrency`, compute-pool size, process
counts, fixture seed. Nothing else in the suite reads an environment variable or
hardcodes a magnitude.

The defaults run **40 MB documents against a small number of clients**, so a
single machine measures the document sizes that actually matter rather than a
crowd it cannot host. That is deliberate: per-document cost is what a laptop can
measure honestly, while per-client cost is close to linear and can be
extrapolated from the constants (see *Derived constants* in `RESULTS.md`). To go
the other way — many clients, small documents — raise `scale.connections`,
`scale.observers` and `scale.scenario.users`, and drop `scale.docSizes`.

### Benchmarking a real document (Y7)

`Y1`–`Y6` measure synthetic documents, which is what makes them reproducible
anywhere — but the shapes are ours. **`Y7` replays a real editing trace instead:
the real document, the real edits, the real users.** It runs automatically if a
trace is present at `benchmarks/custom-trace.anyenc`, and the whole group skips
itself if not, so the suite still runs on any checkout.

[`TRACE-FORMAT.md`](./TRACE-FORMAT.md) documents the format — a single lib0
`writeAny` value holding the document's history as an ordered list of Yjs v1
updates, each tagged with its timestamp, author and kind — **and how to build one
of your own.** You do not need to have recorded anything in advance: yhub already
stores the edit history as attributions (who wrote each id-range, and when), so a
trace is that history turned back into individual updates. To produce one from a
document in a running deployment:

```sh
cd benchmarks
node --env-file-if-exists=../.env tools/build-trace.js --org <org> --docid <docid>
```

[`tools/build-trace.js`](./tools/build-trace.js) opens a read-only hub, groups the
attributed ranges into `(user, timestamp)` steps, carves each step out of the
document with `Y.intersectUpdateWithContentIds`, and refuses to write the result
unless replaying it reproduces the document byte for byte. `TRACE-FORMAT.md` also
covers building one from a yhub *export* instead.

**The trace file itself is gitignored and must stay that way: it is real document
content.** The format document is checked in so a trace can be produced without
one to copy.

Y7 covers the same aspects as the synthetic groups, at a few users and at 100:
primitive costs (Y7.1), replaying the real edit sequence (Y7.2), joining the real
document with and without a pending edit (Y7.3), concurrent editors (Y7.4), and
compaction (Y7.5). Sizes come from the trace, so `scale.docSizes` does not apply.

Two knobs worth knowing about:

- **Disk.** Every compaction rewrites the whole document *and* its nongc twin, so
  a run at 40 MB moves several GB through S3. If the backend fills up, MinIO
  refuses writes and compaction **fails rather than slows** — rooms never drain,
  benchmarks time out, and the numbers look plausible while being meaningless.
  The suite checks free space at startup, reclaims each benchmark's documents as
  it goes, and prints a loud warning if any compaction task errors.
- **`run.useYNative`.** Off by default, so the report describes the `@y/y` merge
  path yhub actually ships. Turn it on and Y1.7 re-runs the two merge benchmarks
  against the native yrs (Rust) binding, which exists to be benchmarked here and
  is exercised by nothing else in the repo.

Groups `Y2`–`Y6` need the databases running; `Y1` is pure CPU and runs anywhere.
The suite forks a server-only and a worker-only y/hub process so that memory and
CPU are attributable per role, and it uses its own Redis prefix and its own
document ids, so it will not disturb a running dev instance beyond the shared
Redis/Postgres/S3 servers themselves.

### Layout

```
src/config.js      every parameter — start here
src/index.js       the runner: selects benchmarks, prints rows, writes RESULTS.md
src/report.js      percentiles and markdown tables
src/derive.js      turns the measured rows back into the cost model below
src/fixtures.js    deterministic documents, cached in fixtures/ (gitignored)
src/measure.js     timing and heap helpers for the pure-CPU benchmarks
src/cluster.js     starts/stops the hub processes; Redis and Postgres probes
src/metrics.js     rss, cpu, event-loop delay, compute-pool depth, S3 op counts
src/client.js      the raw-protocol websocket client (see Notes on methodology)
src/verify.js      Y0.2 — checks that client against real @y/websocket clients
src/proc/hub.js    forked child running one y/hub role — server or worker
src/suites/*.js    the benchmarks themselves, one file per group
```

To add a benchmark, append `{ id, name, run(ctx) }` to a suite's `benchmarks`
array and call `ctx.report.row({...})` as often as you like. Columns carry their
unit in the name (`time (ms)`), so a new row needs no registration anywhere.

## Expensive operations at a glance

If you read nothing else:

- **Writing is cheap.** An update goes client → server → Redis without ever
  building a document. Cost is proportional to the bytes you sent, and nothing
  else.
- **Connecting is cheap. Syncing is not.** Opening a socket and subscribing to a
  room costs almost nothing. Receiving the initial document costs a full
  fetch-merge-scan-copy of the whole document — **once per connection, shared
  with nobody**. 100 users opening the same 40 MB document do that work 100
  times.
- **Merging is the expensive primitive**, and it shows up in three places:
  initial sync, compaction, and (cheaply, per-batch) fan-out.
- **Fan-out costs what broadcast costs.** Each subscriber is sent the messages
  in the batch, so the server-side total is `messages × subscribers`. That is
  inherent to broadcasting and no design avoids it. What *is* avoidable: y/hub
  currently re-merges and re-encodes the batch **per subscriber** rather than
  once per batch, so it pays that product in CPU rather than only in bytes. A
  constant factor, not a worse curve — but a removable one.
- **Awareness (presence) has the same shape and a much larger constant.**
  Merging presence `JSON.parse`s every participant's state and
  `JSON.stringify`s the merged result, where a document update is a memcpy. Same
  `messages × subscribers`, considerably more work per unit.
- **Compaction** is performed by a worker process and should be performed at regular intervals (default: every minute). As stated above, compaction is one of the most expensive operations in yhub.

---

# A. Problem description: benchmarking with an unknown user load

## The immediate question

A deployment wants **1500 concurrently connected active users** — all of them
working, some of them AI agents — editing spreadsheet-like data modelled in Yjs.
Documents reach **40 MB at the maximum**; the average is unknown. AI agents will
often be *creating* those documents in real time. The edit pattern is bursty:
mostly "a batch of edits flushed at once by an agent", sometimes individual
edits.

## Why a single pass/fail number would be useless

Almost every variable that determines the answer is unknown or will change:

- How the 1500 users distribute over documents. Everyone in their own document
  and everyone in one shared document are different systems with different
  bottlenecks, and the truth is somewhere in between — but we don't know where.
- The average document size. "Max 40 MB" bounds one axis and says nothing about
  the distribution, and cost is dominated by the *typical* document, not the
  largest.
- The edit rate, and how bursty it is.
- Whether presence/awareness is used — which, as section B shows, can dominate
  everything else.
- How fast agents generate content, which sets how often documents are
  compacted.

Benchmarking one guessed configuration would produce a number that is obsolete
the moment any of those assumptions moves.

## What this document does instead

**We measure the unit cost of each operation a y/hub connection can perform, and
publish the cost model, so anyone can plug in their own numbers.**

There are only four things a client does over a y/hub connection:

1. **Connect and subscribe** — open a websocket, authenticate, join a room.
2. **Sync a document** — receive the current state of the document as a
   `syncStep1` + `syncStep2` pair. Happens on every connect *and* every
   reconnect.
3. **Write an update** — send an edit.
4. **Receive updates** — get other participants' edits (and, optionally,
   presence) relayed to you.

Plus one thing the system does on your behalf, which you never see but pay for:

5. **Compaction** — a background worker periodically merges a document's pending
   updates into its persisted form.

Each of these has a different cost curve, and each scales with a different
variable — bytes sent, document size, number of subscribers, number of present
users, document growth rate. Section B grades them. Section C is the set of
experiments that measures them.

The output is a table of constants plus formulas, so that "can y/hub handle
*my* load?" becomes arithmetic rather than another benchmark run.

## Cost model

The formulas the benchmarks exist to populate. Symbols: `n_conn` connected
clients, `n_r` subscribers on room `r`, `S` document size, `u_r` updates/s,
`a_r` awareness updates/s, `j` joins/s.

```
server_mem   ≈ B_srv + n_conn·c_conn + n_room·c_room + concurrent_syncs·k_sync·S
server_cpu/s ≈ Σ_r [ u_r·n_r·(t_merge_small + t_encode) + a_r·n_r·t_aw(n_r) ]
             + j·( t_fetch(S) + t_sv(S) + t_merge(S, n_pending) )
             + (Σ_r u_r)·t_contentids
worker_peak  ≈ k_wrk·(S_gc + S_nongc)·taskConcurrency
```

Everything on the right that is not a workload parameter is a constant we
measure.

---

# B. Terminology and cost tiers

## Terms

**Room** — one document on one branch, addressed as `{org, docid, branch}`. The
unit of subscription and of compaction.

**Update** — a binary Yjs change. Cell edits are tens of bytes; an agent's
flushed batch can be hundreds of kilobytes.

**Sync** — the server sending a client the current document state as one
`syncStep2` message. Not incremental: the client receives the whole document.

**Merge** — combining several encoded updates into one. y/hub does this in two
different ways, and the difference is large:
- *binary merge* (`Y.mergeUpdates`) — decodes and re-encodes block sets without
  building a document. Used for fan-out and for the nongc document.
- *document merge* (`new Y.Doc()` → `applyUpdate` × N → `encodeStateAsUpdate`) —
  builds a real in-memory document. Used whenever garbage collection is
  required, i.e. for the gc document on every compaction (`src/y-utils.js:35-44`).
  Much more expensive in both time and peak memory.

Special case worth knowing: `Y.mergeUpdates` returns its input unchanged when
given exactly one update (`node_modules/@y/y/src/utils/encoding.js:464`). Merging
is free for a document with nothing pending, and full price otherwise. That
single branch is responsible for most of the variance in sync cost.

**Compaction** — the background job that folds a room's pending Redis updates
into its persisted form and rewrites it. Triggered when a room receives its first
write after being idle (`src/stream.js:149-152`), and **re-triggered immediately
after each compaction as long as the room's stream is non-empty**
(`src/stream.js:192-197`). The worker picks up a pending task once it has been
idle for `taskDebounce` (`src/stream.js:538`). Net effect: **a continuously
edited room is compacted roughly every `taskDebounce` seconds, and every
compaction rewrites the whole document.**

**Fan-out** — delivering one room's messages to its subscribers. The Redis read
is shared across all rooms in a process (`src/stream.js:292`); the per-subscriber
work is a filter by that subscriber's clock, then a merge, encode and copy
(`src/stream.js:298-309`, `src/server.js:632-637`).

**Awareness** — presence: cursors, selections, "who is here". Ephemeral, not
persisted, but relayed through the same stream.

## Tiers

Grades describe **how cost scales with the thing that grows**, not how slow one
call is. A tier-A operation run a million times still costs something; a tier-F
operation is one you cannot outrun by buying a bigger machine.

Two things the grades deliberately do *not* punish:

- **Broadcast is a product and that is fine.** Sending B bytes to N subscribers
  costs `B × N`. Every collaborative backend pays this; it is the problem, not a
  flaw in the solution. Fan-out is graded on its **per-connection** cost, which
  is what a design can actually influence.
- **Constant factors are graded as constants.** Doing avoidable work per
  connection is a real cost and is called out in the notes, but it does not
  change the curve and does not change the tier.

| tier | meaning |
|---|---|
| **A** | Constant. Independent of document size, participant count and history. |
| **B** | Linear in the bytes of that one operation. Per connection for anything broadcast. |
| **C** | Linear in **document size** (or backlog size), paid once per sync. Predictable but not small. |
| **D** | Tier-C work repeated per connection **where one computation could serve all of them**. Avoidable, and the constant is large. |
| **E** | Linear in document size **× how often it recurs**. A standing background cost that scales with both size and write rate. |
| **F** | Superlinear over a document's lifetime — total cost grows faster than the document being built. |

## The operations

| # | Operation | When it happens | What it costs | Tier |
|---|---|---|---|---|
| 1 | Websocket upgrade + auth | every connect | one auth callback, one small object (`src/server.js:696-731`) | **A** |
| 2 | Room subscription | every connect | one map/set insert; the Redis `XREAD` is shared across all rooms in the process (`src/stream.js:292`) | **A** |
| 3 | Idle connection | continuously | a `WSUser` and a socket. No `Y.Doc` per connection or per room; no document cache anywhere in the heap (`src/server.js:555-600`, `src/stream.js:110`) | **A** |
| 4 | Write an update | every edit | one buffer copy + one linear scan (`Y.createContentIdsFromUpdate`) + one Redis `XADD`. No document is built (`src/server.js:778-788`) | **B** |
| 5 | Deliver a batch to one subscriber | every edit on your room | filter by the subscriber's clock, binary merge, encode, copy — linear in the batch (`src/server.js:632-637`). Server-side total is this × subscribers, which is what broadcast costs. | **B** |
| 6 | Deliver an awareness batch to one subscriber | every presence tick | same shape as #5, much larger constant: `JSON.parse` per participant state per message, then `JSON.stringify` per state of the merged result (`@y/protocols/src/awareness.js:209,257`), plus an `Awareness` + throwaway `Y.Doc` + `setInterval` per call (`src/protocol.js:25`). Same redundancy as #5 and no `@todo` | **B** |
| 7 | Fetch the persisted document | every sync | one Postgres `SELECT` plus **one S3 GET per uncompacted row**, buffered then concatenated then decoded — several copies (`src/persistence.js:171`, `src/plugins/s3.js:102-106`) | **C** |
| 8 | Compute the state vector | every sync | full linear scan of the document; runs inline below 512 KB, offloads above (`src/compute.js:313-327`). The source comments ~30–40 MB/s — **unverified, and load-bearing** | **C** |
| 9 | Merge pending updates into the document | every sync **to a room written since its last compaction** — i.e. almost always, for an active document | full binary merge of the whole document plus everything pending. Free if nothing is pending (see the one-update shortcut above) | **C** |
| 10 | Many clients syncing one document at once | deploys, load-balancer failover, reconnect after a network blip, everyone opening the same document at 09:00 | #7+#8+#9 run **independently per connection with no sharing** (`src/server.js:740-764`). The bytes sent are inherent; the fetch, merge and scan are not — one computation could serve every concurrent joiner of the same room. At 40 MB the constant is enormous | **D** |
| 11 | Compaction of one document | every `taskDebounce` while the room is being written | reads gc **and** nongc blobs, **document-merges** the gc side through a real `Y.Doc`, re-encodes, writes four fresh assets to S3, deletes the old ones (`src/index.js:85-91`). Peak memory is a multiple of document size, counted twice | **E** |

## Reading the table

**Operations 1–4 are cheap and stay cheap.** Connections, subscriptions and
writes scale the way you would want. If your load is "many users, many small
documents, moderate write rate", y/hub's design is well matched to it and the
expected bottleneck is Redis and Postgres rather than the server process.

**Operations 5–6 are broadcast, and broadcast is a product.** `messages ×
subscribers` is the irreducible cost of telling N people what happened. The
question worth benchmarking is not the curve but the **constant**: y/hub
currently merges and encodes once per subscriber instead of once per batch, so
it spends CPU where it only needed to spend bandwidth. For document updates that
constant is a memcpy and probably tolerable. For awareness it is a JSON
round-trip per participant state, which is plausibly an order of magnitude
worse — **that gap, not any exponent, is what makes presence the thing to ask
about on a large shared document.** Y1.5 and Y4.2/Y4.3 measure it.

**Operations 7–10 make sync the dominant per-connection cost**, and 11 is what
happens when many of them land together. Individually they are ordinary linear
work. What makes 11 a tier above is that the expensive parts are *identical
across concurrent joiners of the same room* and are nevertheless recomputed for
each one — unlike broadcast, this product is avoidable.

---

# C. The benchmarks

Structured after [crdt-benchmarks](https://github.com/dmonad/crdt-benchmarks):
grouped, individually named, each with the metrics it reports in parentheses, and
each stated in terms of what you learn from it rather than what it does
mechanically.

## Metrics

Reported per benchmark; percentiles rather than means, because the tail is the
failure being looked for.

| metric | meaning |
|---|---|
| `time` | wall-clock duration of the operation |
| `syncTime` | connect → `syncStep2` received, p50/p95/p99/max |
| `propagationTime` | edit sent by one client → observed by another, p50/p95/p99/max |
| `serverMem` | server RSS, and peak RSS (`VmHWM`), split into JS heap vs. `external`/`arrayBuffers` — binary relay traffic lives outside the JS heap |
| `serverCpu` | server CPU seconds, main thread separated from compute-pool threads |
| `loopDelay` | event-loop delay p99. For a single-threaded relay this is *the* saturation signal |
| `queueDepth` | compute-pool queue length (`src/compute.js:244`) — the queue is unbounded and holds full payloads |
| `workerTime` | compaction task duration |
| `workerMem` | worker peak RSS |
| `s3Ops` / `s3Bytes` | S3 GET/PUT counts and bytes. Counts matter more than local latency — see Notes |
| `pgRows` | rows in `yhub_ydoc_v1`; every uncompacted row is an S3 GET on every sync |
| `streamLen` | Redis `XLEN` per room; growth means compaction is not keeping up |
| `docSize` | serialized document size, gc and nongc separately |
| `memUsed` | heap used by an in-memory `Y.Doc`, for the expansion factor |
| `dropped` | connections closed for backpressure (`src/server.js:650-653`) |

## Y1: Primitive costs

No network, no databases, seconds to run. These establish the constants that
every other benchmark is interpreted against, and several of the section B tier
grades stand or fall here. Run these first — if `Y1.5` or `Y1.2` is bad enough on
its own, the answer is already visible at a fraction of the effort.

- **Y1.1] Binary-merge a document of size S with k pending updates** (`time`,
  `memUsed`) — the cost of *merge pending updates on sync*, and the shape of the
  sync cliff. Sweep both S and k; k=0 and k=1 should be free.
- **Y1.2] Compute the state vector of a document of size S** (`time`,
  throughput MB/s) — *compute the state vector*, paid on every sync. Checks the
  ~30–40 MB/s figure asserted at `src/compute.js:313`. If it holds, a 40 MB
  document costs about a second of CPU *per connection*.
- **Y1.3] Create content IDs from an update of size U** (`time`) — *write an
  update*, on the main thread for every inbound message (`src/server.js:786`).
  Establishes that writing really is tier B.
- **Y1.4] Document-merge: build a `Y.Doc` from size S and re-encode** (`time`,
  `memUsed`) — the core of *compaction*, and it yields the **`Y.Doc` expansion
  factor**: heap bytes per serialized byte. The single most important constant
  for sizing workers — and the same factor applies in the browser, so it also
  tells the customer what a 40 MB document costs their client.
- **Y1.5] Merge a batch of N awareness updates**, N swept 1 → 1500 (`time`,
  `memUsed`) — *awareness delivery* and *awareness on sync* in isolation, with
  no network harness needed. Measures the constant that separates presence from
  document relay. Vary the size of the state object too (a bare cursor vs.
  cursor + name + colour + selection), since the cost is dominated by
  `JSON.parse`/`JSON.stringify` per state rather than by the throwaway `Y.Doc`
  the `Awareness` constructor requires.
- **Y1.6] Structured-clone a buffer of size S to a compute worker** (`time`) —
  payloads are sent without transfer (`src/compute.js:286`), so this overhead is
  paid on every offloaded merge and state-vector computation.
- **Y1.7] Y1.1 and Y1.4 with `USE_Y_NATIVE=1`** (`time`, `memUsed`) — the native
  yrs merge path exists specifically to benchmark this hot path
  (`src/y-utils.js:6`, README.md:336-368) and nothing currently exercises it. If
  it is substantially faster it changes the scaling advice.

## Y2: What does a connected user cost?

Answers "can I afford N connections", separately from "can I afford N
subscribers on one document".

- **Y2.1] Connect N clients to N distinct empty documents** (`serverMem`,
  `syncTime`, `time`) — the per-connection **and** per-room floor. Establishes
  `c_conn` and `c_room`.
- **Y2.2] Connect N clients to one empty document** (`serverMem`, `syncTime`) —
  the same floor without the per-room term. The difference against Y2.1 is the
  cost of a room.
- **Y2.3] Idle: hold N connections for T minutes with no traffic** (`serverMem`
  drift, `serverCpu`) — confirms that idle connections are genuinely tier A and
  that nothing accumulates.
- **Y2.4] Connect N clients to one document of size S, all at once**
  (`syncTime` p99, `serverMem` peak, `queueDepth`, `dropped`) — the join storm,
  *many clients syncing one document at once*. Sweep S over 1 MB / 10 MB /
  40 MB. This is the benchmark that provokes the unbounded compute queue.
- **Y2.5] Connect N clients to one document of size S, ramped at r conn/s**
  (`syncTime` p99, `serverMem` peak, `queueDepth`) — finds the join rate a
  single server sustains at each document size. Directly actionable: it is the
  number that tells you how fast you may roll a deploy.
- **Y2.6] Sync a document of size S with k pending stream updates**, k swept 0 →
  1000 (`syncTime`, `s3Ops`, `serverCpu`) — **the sync cliff**: *merge pending
  updates on sync*, over the network. A benchmark that syncs only against
  freshly compacted documents will report a per-sync cost several times lower
  than production and miss the dominant term entirely. Includes the `pgRows`
  effect: every uncompacted row is an extra S3 GET.

## Y3: What does writing cost?

Modelled on the actual pattern: agents flushing batches, humans making single
edits.

- **Y3.1] One client writes N single-cell updates to a document of size S**
  (`time`, `propagationTime`, `serverCpu`, `streamLen`) — the individual-edit
  case. Confirms write cost is independent of S.
- **Y3.2] One client flushes a batch of N cell edits as a single update**
  (`time`, `docSize` of the update, `propagationTime`, `serverCpu`) — **the
  agent flush**. Sweep N from 100 to 100,000. Establishes whether large single
  updates are cheaper per cell than many small ones, which determines whether
  agents should batch aggressively.
- **Y3.3] M clients writing to M distinct documents at rate u** (`serverCpu`,
  `loopDelay`, `workerTime`, `streamLen`) — write throughput when load is spread.
  Expect the worker, not the server, to bind first.
- **Y3.4] M clients writing to the *same* document at rate u** (`serverCpu`,
  `loopDelay`, `propagationTime` p99) — the same write load concentrated. The
  gap against Y3.3 *is* the per-subscriber delivery cost.
- **Y3.5] Y3.2 with M agents flushing simultaneously to one document**
  (`loopDelay`, `propagationTime` p99, `dropped`) — bursty concentrated writes,
  the realistic worst case for this workload.

## Y4: What does an observer cost?

Broadcast costs `messages × subscribers` no matter how it is built. These
benchmarks hold the write rate fixed and vary only the audience, to measure the
**per-subscriber constant** — the part a design can actually change.

- **Y4.1] One writer, N observers on one document**, N swept 1 → 1500
  (`serverCpu` per update per observer, `loopDelay`, `propagationTime` p99) —
  the per-observer cost of an update. Expected linear; the constant is what
  matters. Tells you how many observers one server sustains per update/s.
- **Y4.2] Y4.1 with awareness enabled** (same metrics, plus `serverCpu`
  attributable to awareness) — the difference against Y4.1 is the price of
  presence. Predicted to dominate; if it does, that is the headline finding for
  any large shared document.
- **Y4.3] N clients emitting presence at 1 Hz on one document, no document
  edits**, N swept 1 → 1500 (`loopDelay`, `serverCpu`) — awareness alone: the
  case where the batch is largest relative to the payload, and where the
  per-subscriber JSON constant is least diluted by anything else. Expected to
  saturate the event loop before memory becomes a concern.
- **Y4.4] Y4.1 across 2 and 3 server processes** (`serverCpu` per process,
  `loopDelay`, Redis ops/s) — confirms fan-out cost partitions across pods, and
  that Redis does not become the bottleneck first. This is what justifies "add a
  server" as the remedy.

## Y5: What does a document's lifetime cost?

The background cost nobody sees, and the group most relevant to agent-generated
content.

- **Y5.1] Grow a document from empty to size S by streaming updates at rate w**
  (`s3Bytes` and `s3Ops` cumulative, `workerTime` cumulative, `workerMem` peak,
  `pgRows` and `streamLen` over time).
  The headline result is total bytes written versus final document size. If
  building a 40 MB document costs an order of magnitude more than 40 MB of
  writes, that is the finding.
- **Y5.2] Y5.1 sweeping `taskDebounce`** (same metrics, plus `syncTime` measured
  throughout the growth) — the central trade-off: infrequent compaction means
  less rewriting but slower syncs, longer Redis streams and more S3 GETs per
  sync. Should produce a recommended setting as a function of growth rate.
- **Y5.3] Compact a document of size S: fresh vs. churned vs. row-churn**
  (`workerTime`, `workerMem` peak, `s3Bytes`, `docSize` gc vs. nongc) — the
  worker persists **both** the gc and nongc documents (`src/index.js:85`).
  Overwriting a cell in a `Y.Map` tombstones the old value, so a spreadsheet
  worked on for a week can be 40 MB gc and several hundred MB nongc. This
  measures how much history actually costs.
- **Y5.4] `taskConcurrency` sweep at S = 40 MB** (`workerMem` peak, `workerTime`,
  tasks/s) — finds the OOM boundary. `bin/yhub.js:47` ships 5; `tests/utils.js:58`
  uses 500. At 40 MB one of those is wrong.
- **Y5.5] Steady state: a document of size S under continuous edits for T
  minutes** (`streamLen` over time, `pgRows` over time, `workerTime`) — is
  compaction keeping up? Rising `streamLen` or `pgRows` means it is not, and
  every sync is getting more expensive as a result. This is the metric to alert
  on in production.

## Y6: The target scenario

Composed from the groups above once their constants are known, to check that the
model predicts reality.

- **Y6.1] 1500 users across 1500 documents, agent-flush write pattern**
  (all metrics) — the spread case.
- **Y6.2] 1500 users on one 40 MB document** (all metrics) — the concentrated
  case. Run with and without awareness.
- **Y6.3] 1500 users across 150 documents** (all metrics) — a plausible real
  distribution.
- **Y6.4] 1500 users across 15 documents** (all metrics) — locates the crossover
  between Y6.1 and Y6.2.
- **Y6.5] Y6.2 across 3 server processes and 3 workers** (all metrics) — what it
  takes to make the hard case work, and therefore the scaling recommendation.
- **Y6.6] 100 agents each building a document to 40 MB concurrently**
  (`s3Bytes`, `workerMem` peak, `workerTime`, `streamLen`) — the agent workload
  at scale; Y5.1 multiplied. Likely the binding constraint for this deployment,
  and it is a *worker* constraint, not a server one.

---

## Notes on methodology

**The load generator is not a Yjs client.** 1500 clients each holding a 40 MB
`Y.Doc` does not fit on one machine, and would measure client memory rather than
server memory. The generator is a raw-protocol client: it reads the leading
varuints of each frame, records the `syncStep2` byte count and arrival time, and
discards the payload; it sends pre-generated update frames. This is protocol-
legal rather than a shortcut — the server ignores client `syncStep1`
(`src/server.js:789-790`) and reacts only to `syncStep2`/`syncUpdate`, so a
passive client never sends a large diff back. A handful of real `@y/websocket`
clients run alongside to verify that edits actually arrive correctly.

**Server and worker run as separate processes**, so memory is attributable, with
CPU cores pinned to disjoint sets. Note that `taskset` does not change
`os.cpus().length`, so the compute pool would still size itself to the full
machine (`src/compute.js:227`); pool size must be set explicitly.

**Fixtures** are flat `Y.Map`s keyed `"row:col"`, generated to target serialized
sizes, saved to disk for reproducibility (as `large2.test.ydoc` and
`large3.test.ydoc` already are), and reported in **cells per MB** so real
spreadsheets can be mapped onto our size steps. Three 40 MB variants — *fresh*
(written once), *churned* (every cell rewritten ~10×), *row-churn* (rows inserted
and deleted) — because they stress compaction very differently (Y5.3).

**`s3Ops` matters more than S3 latency.** MinIO on localhost is far faster than
real S3 or R2, so measured sync and compaction times are lower bounds. Recording
operation counts and payload sizes lets real-world latency be layered on
analytically instead of pretended away.

**Percentiles, not means.** A mean hides exactly the tail that constitutes the
failure.

**What this cannot tell you:** real network RTT and TLS costs; genuine multi-host
behaviour (multi-pod is several processes on one box sharing one Redis — enough
to confirm partitioning, not a substitute for a staging run); and anything about
the customer's client. On that last point, worth stating explicitly: a 40 MB Yjs
document in a browser costs the `Y.Doc` expansion factor measured in **Y1.4**,
and that may well be a tighter constraint than anything on the server.
