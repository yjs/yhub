import * as env from 'lib0/environment'
import * as number from 'lib0/number'

/**
 * Every parameter of the benchmark suite. This is the only file you should need
 * to edit.
 *
 * Defaults measure **20 MB documents against a small number of clients**, which
 * is what a single machine can measure honestly: per-document cost is the hard
 * part, while per-client cost is close to linear and extrapolates from the
 * constants in RESULTS.md. Raising `scale` is the normal way to use this suite;
 * everything else is a knob you turn when chasing a specific question.
 */

const mb = 1024 * 1024

export const config = {
  /**
   * Where the databases are. Defaults read the same env vars as the rest of the
   * repo (`.env` is loaded by the `npm start` script), so if `npm test` works,
   * these work. Override inline to point at a different deployment.
   */
  dbs: {
    redis: env.getConf('redis') ?? 'redis://localhost:6379',
    postgres: env.getConf('postgres') ?? 'postgres://postgres:postgres@localhost:5432/postgres',
    /**
     * Redis key prefix. Deliberately distinct from `yhub` (production) and
     * `yhub:testing` (the test suite) so a run cannot collide with either.
     */
    redisPrefix: 'yhub:bench',
    s3: {
      bucket: env.getConf('S3_YHUB_TEST_BUCKET') ?? 'ydocs-testing',
      endPoint: env.getConf('S3_ENDPOINT') ?? 'localhost',
      port: number.parseInt(env.getConf('S3_PORT') ?? '9000'),
      useSSL: env.getConf('S3_SSL') === 'true',
      accessKey: env.getConf('S3_ACCESS_KEY') ?? 'minioadmin',
      secretKey: env.getConf('S3_SECRET_KEY') ?? 'minioadmin'
    }
  },

  /**
   * How the y/hub processes under test are configured. These are the settings a
   * deployment would tune, so several benchmarks sweep them explicitly (Y5.2
   * sweeps `taskDebounce`, Y5.4 sweeps `taskConcurrency`) — the values here are
   * the baseline everything else runs at.
   */
  hub: {
    /**
     * ms before a worker claims a compaction task. Production default: 120000.
     *
     * This is the `XAUTOCLAIM` min-idle-time (`src/stream.js:538`), so it must
     * exceed how long a compaction actually takes. If it does not, a second
     * worker reclaims a task the first is still working on, both persist it, and
     * the loser dies on a duplicate-key violation. That cannot happen with a
     * single worker — it needs `workers > 1`, which only Y6.5 uses. 20 MB
     * compactions take seconds, hence 10s rather than the 1s that a small-
     * document suite could get away with.
     */
    taskDebounce: 10000,
    /** ms an update stays in the Redis stream before it may be trimmed. Production default: 60000 */
    minMessageLifetime: 3000,
    /** seconds of API response caching. Kept low so read benchmarks measure work, not a cache hit. */
    cacheTtl: 1,
    /** compaction tasks a worker runs in parallel. `bin/yhub.js` ships 5. */
    taskConcurrency: 5,
    /** compute-pool threads per process. `null` = cpus-1. Pinned here so results are comparable across machines. */
    computePoolSize: 4,
    /** first port used; extra server processes take basePort+1, +2, ... */
    basePort: 9500,
    /** server processes to fork. Y4.4 and Y6.5 override this. */
    servers: 1,
    /** worker processes to fork. Y6.5 overrides this. */
    workers: 1,
    /** org name used for every room the suite creates */
    org: 'bench'
  },

  /**
   * The sweeps. This is what you raise to run the real thing.
   */
  scale: {
    /**
     * Y2.1-Y2.5: concurrent connections.
     *
     * Connections themselves are cheap — ~0.10 MB of server RSS each (Y2.2), so
     * 1500 is ~150 MB and the limit is nowhere near here.
     */
    connections: [1, 10, 100, 500, 1500],
    /**
     * Y2.4 only: the largest *simultaneous* join of a sized document.
     *
     * This is the one thing that does not scale with the rest. Y2.4 measures
     * `3.49 MB` of peak server RSS per concurrent joiner per MB of document, so
     * 150 joiners on a 20 MB document is already ~10 GB — and the load generator
     * holds a copy of each in-flight document too. Above this, joins have to be
     * ramped, which is what Y2.5 measures. Raising it past what RAM allows does
     * not produce a bigger number, it produces a swap storm.
     */
    joinStormMax: 150,
    /** Y2.4-Y2.6, Y6: document sizes to sync */
    docSizes: [0, 4 * mb, 20 * mb],
    /** Y1: document sizes for the pure-CPU primitives */
    primitiveDocSizes: [mb, 5 * mb, 20 * mb],
    /** Y1.1, Y2.6: pending (uncompacted) updates at sync time. Deeper: [0, 1, 10, 100, 1000] */
    pendingUpdates: [0, 1, 10, 100],
    /**
     * Y1.5, Y4.1-Y4.3: subscribers / present users.
     *
     * Fan-out of document updates is ~12 µs of marginal server CPU per delivery,
     * so 1500 observers at one edit per second is a couple of percent of a core.
     * Presence is the expensive one: ~0.066% of a core per client at 1 Hz, which
     * puts the single-core saturation point right around 1500. That is the point
     * of running this sweep at 1500 rather than a comfortable number.
     */
    observers: [1, 10, 100, 500, 1500],
    /** Y2.5: connection ramp rates, connections per second */
    joinRates: [5, 25, 100],
    /** Y3.2: cells in one agent flush. Full scale: [100, 1000, 10000, 100000] */
    batchCells: [100, 1000, 10000],
    /** Y3.1: single-cell updates one client sends */
    singleEdits: 500,
    /** Y3.3-Y3.5: writers, and updates per second each writer emits */
    writers: [1, 50, 200],
    writeRate: 10,
    /** Y4.3: presence ticks per second per client */
    awarenessRate: 1,
    /** Y5.1, Y5.2: document size to grow to, and the update size used to grow it */
    growthTarget: 20 * mb,
    growthChunk: 256 * 1024,
    /** Y5.2: taskDebounce values to sweep, ms */
    taskDebounces: [500, 2000, 10000],
    /**
     * Y5.4: taskConcurrency values to sweep. Y5.4 seeds `2 × taskConcurrency`
     * documents of `scenario.docSize`, and the worker holds a `Y.Doc` per
     * concurrent task — at 20 MB that is ~230 MB of heap each (Y1.4's expansion
     * factor). Raising the top of this sweep is how you find the OOM boundary;
     * it is capped here so the default run does not simply kill the worker.
     */
    taskConcurrencies: [1, 3, 8],
    /** Y5.5, Y2.3: how long the steady-state / idle benchmarks hold, ms. Full scale: 300000 */
    holdMs: 15000,
    /**
     * Y6: the target scenario. Full scale: users 1500.
     *
     * These are the most expensive benchmarks in the suite: each one seeds
     * `docCounts` documents, compacts them, then drives `users` clients through
     * `editRounds` flushes and waits for the system to settle. Raise
     * `run.benchmarkTimeoutMs` along with these — and check free disk, since a
     * full S3 backend makes compaction fail rather than merely slow down.
     */
    scenario: {
      users: 500,
      /**
       * Deliberately smaller than `scale.docSizes`. Y6.1 gives every user their
       * own document, so `users × docSize` is seeded and compacted before the
       * measurement even starts — 500 × 20 MB would be 10 GB of documents and
       * hours of compaction. Large *documents* are what Y2 and Y7 measure; Y6 is
       * where large *populations* are measured. Trying to do both at once is
       * what makes a run stop finishing.
       */
      docSize: 4 * mb,
      /** Y6.1/6.3/6.4/6.2: how the users are spread over documents */
      docCounts: [500, 50, 5, 1],
      /** flushes per user, and cells per flush */
      editRounds: 3,
      cellsPerEdit: 100,
      /** Y6.6: agents concurrently building a document each. Full scale: 100 */
      agents: 4
    }
  },

  /**
   * Fixture documents. Generated deterministically from `seed`, cached in
   * `benchmarks/fixtures/`. Delete that folder to regenerate.
   *
   * Shape is a flat `Y.Map` keyed `"row:col"`, matching the spreadsheet-like
   * workload the cost model was written for.
   */
  fixtures: {
    seed: 42,
    /** characters per cell value; drives the cells-per-MB ratio */
    cellChars: 24,
    /** columns per row before wrapping to the next row */
    cols: 32,
    /** `churned`: times each cell is rewritten (tombstones the old value) */
    churnFactor: 10,
    /** `rowChurn`: fraction of rows that are inserted and then deleted */
    rowChurnRatio: 0.5,
    /**
     * Live-content size of the `churned` / `rowChurn` fixtures, used by Y5.3.
     *
     * Kept independent of `scale.scenario.docSize` on purpose: churning holds
     * the whole history in one `gc:false` document, so a churned 40 MB fixture
     * is ~400 MB serialized and — at Y1.4's 12.9× expansion — several GB of heap
     * just to generate. Y5.3 measures the gc-vs-nongc *ratio*, which is the same
     * shape at any size. Raise it if you specifically want compaction timings
     * for a 40 MB churned document, and raise `--max-old-space-size` with it.
     */
    churnTarget: 4 * mb
  },

  /**
   * Y7: a real editing trace, if one has been supplied.
   *
   * Everything else in this suite runs on synthetic documents, which lets it be
   * reproducible but means the shapes are ours rather than a customer's. Drop a
   * trace at `benchmarks/custom-trace.anyenc` and Y7 replays it: the real
   * document, the real edits, the real users. The whole group is skipped when
   * the file is absent, so the suite still runs anywhere.
   *
   * The file is gitignored — it is customer data and must not be committed.
   * `TRACE-FORMAT.md` documents the format and *is* checked in.
   */
  trace: {
    /** relative to `benchmarks/` */
    file: 'custom-trace.anyenc',
    /**
     * Y7.3: clients syncing the traced document.
     *
     * Each join transfers the whole document, so N joiners means N × ~51 MB in
     * flight at once. Above `joinRateAbove` the arrivals are ramped at
     * `joinRate`/s instead of all at once — 100 simultaneous joiners on a 51 MB
     * document is several GB of send buffers and stops being a measurement of
     * anything except how the process degrades.
     */
    users: [1, 10, 100, 500],
    joinRateAbove: 20,
    joinRate: 10,
    /** Y7.4: clients replaying the traced edits concurrently */
    writers: [1, 25, 100],
    /** Y7.2: times the edit sequence is replayed, to get a percentile worth reading */
    replays: 3
  },

  /**
   * How the runner behaves.
   */
  run: {
    /** groups executed by a bare `npm start`. Pass ids on the CLI to narrow. */
    suites: ['y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'y7'],
    /** discarded iterations before timing, for the pure-CPU primitives */
    warmupRuns: 1,
    /** timed iterations of each primitive; the median is reported */
    runs: 3,
    /** how often child processes sample rss/cpu/loop-delay, ms */
    sampleIntervalMs: 100,
    /** where results are written, relative to `benchmarks/` */
    outFile: 'RESULTS.md',
    /**
     * Y1.7: also re-run Y1.1 and Y1.4 in a second process with `USE_Y_NATIVE=1`,
     * which routes merging through the native yrs (Rust) binding instead of
     * `@y/y`. Off by default so the reported numbers describe the path yhub
     * actually runs in production. Turn it on to find out whether the native
     * merge is worth adopting — nothing else in the repo exercises it.
     */
    useYNative: false,
    /** ms a single benchmark may take before it is abandoned and reported as timed out */
    benchmarkTimeoutMs: 45 * 60 * 1000
  }
}

export default config
