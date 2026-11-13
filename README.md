# effect-bench

Benchmarks for [Effect](https://effect.website) code, with JSON output and baseline verdicts built for agents and CI.

Community project, not affiliated with the Effect team.

```ts
// bench/user.bench.ts
import { Bench } from '@effect-bench/core'
import { Effect, Schema } from 'effect'

const User = Schema.Struct({ id: Schema.Number, email: Schema.String, tags: Schema.Array(Schema.String) })
const user = { id: 1, email: 'ada@example.com', tags: ['admin'] }
const decodeSync = Schema.decodeUnknownSync(User)
const decodeEffect = Schema.decodeUnknownEffect(User)

export default Bench.suite('userSchema')(
  Bench.group('decode', { baseline: 'sync' })(
    Bench.sync('sync', () => decodeSync(user)),
    Bench.make('effect', () => decodeEffect(user)),
  ),
  Bench.params('stringify', { rows: [10, 1000] }, {
    prepare: ({ rows }) => Effect.succeed(Array.from({ length: rows }, () => user)), // untimed
    sync: users => JSON.stringify(users),                                            // timed
    budget: { p99: '5 millis' },
  }),
)
```

```bash
effect-bench list
effect-bench run --save before          # store a baseline
effect-bench run --compare before --json
effect-bench check --compare before     # exit 1 on a regression or blown budget
effect-bench run --rigorous --forks 8   # more processes for a tighter interval
```

## Writing benches

| Constructor | Measures |
| --- | --- |
| `Bench.make(name, effect)` | re-runs one Effect value |
| `Bench.make(name, ctx => effect)` | builds and runs a fresh Effect per operation |
| `Bench.sync(name, ctx => value)` | a plain function |
| `Bench.params(name, matrix, { prepare?, run \| sync })` | one bench per combination, ids like `stringify[rows=1000]` |
| `Bench.group(name, { baseline })(...)` | alternatives, reported as a ratio to the baseline |
| `Bench.make(name, { prepare?, before?, run })` | `before` builds a fresh input for every operation, untimed |
| `Bench.throughput(name, { ops, concurrency, prepare?, run })` | `ops` operations at that many fibers, per operation; an array of concurrencies gives ids like `offer[concurrency=16]` |
| `Bench.stream(name, { prepare?, stream })` | a stream run to the end, per item; metrics `firstItem`, `items` and `peakRss` |
| `Bench.scenario(name, { prepare?, before?, run, verify? })` | a longer flow, timed once per run; `verify` checks every run |
| `Bench.phase(name, effect)` | times part of a scenario, reported as `phase:name` (nested as `outer/inner`) |
| `Bench.load(name, { rps, duration, send, isError? })` | operations started at a constant rate; latency per operation, ids like `send[rps=200]` |
| `SqlBench.make(name, { prepare?, before?, run, rollback? })` | queries through the layer's `SqlClient`, each in a rolled-back transaction |
| `HttpBench.load(name, { request, rps, duration, isError? })` | requests through the layer's `HttpClient` at a constant rate |

`Bench.suite(name, { layer, setup, ...options })` builds `layer` once per suite and runs `setup` in the suite's scope; its result is the `ctx` each bench receives. Benches can only use services the layer provides — anything else is a type error.

Options (suite or bench): `samples`, `minTime`, `warmup`, `memory` (GC + heap delta per sample), `budget: { p50, p99, heapDelta, errorRate }`, `tags`, and `check` (validates one result before timing). A `heapDelta` budget such as `'2 MiB'` turns on `memory`. Scenarios default to 10 samples with no warmup time, streams to 10 samples.

```ts
Bench.scenario('import', {
  before: () => writeFixture(rows),                    // untimed, every run
  run: file =>
    Effect.gen(function* () {
      const parsed = yield* Bench.phase('parse', parseCsv(file))
      return yield* Bench.phase('insert', insertRows(parsed))
    }),
  verify: inserted => inserted === rows.length,
})
```

Streams, scenarios and load benches add a `metrics` record to each result; the key suffix gives the unit (`firstItemNs`, `peakRssBytes`, `phase:parseNs`). `peakRss` is the whole process's resident memory, so earlier benches in the same process count toward it.

## Databases and APIs

The database or server comes from the suite's `layer`; effect-bench never starts one. Point the layer at a local or test instance (for example one started with testcontainers) so network noise stays small.

```ts
import { Bench, HttpBench, SqlBench } from '@effect-bench/core'
import { HttpClientRequest } from 'effect/http'
import { SqlClient } from 'effect/sql'

export default [
  Bench.suite('entries', { layer: TestDatabase })(
    SqlBench.make('upsertBatch', {
      before: () => Effect.sync(() => batchOf(500)),      // untimed
      run: rows => Effect.flatMap(SqlClient.SqlClient, sql => upsertEntries(sql, rows)),
    })
  ),
  Bench.suite('datasetsApi', { layer: ApiClient })(       // HttpClient with the base URL set
    HttpBench.load('listEntries', {
      request: HttpClientRequest.get('/datasets/ds_1/entries?limit=100'),
      rps: [100, 500],
      duration: '20 seconds',
      budget: { p99: '150 millis', errorRate: 0.001 },
    })
  ),
]
```

- `SqlBench.make` runs each operation in a transaction that is rolled back, so every operation sees the same data. An empty rolled-back transaction is timed and subtracted, so the result is the cost of `run` itself. Commit cost (WAL flush) is not measured, and sequences still advance. `rollback: false` runs it as a plain `Bench.make`.
- `HttpBench.load` starts requests on schedule whether or not earlier ones have finished, and times each from when it was due, so a slow server cannot hide its own queueing. Responses of 400 and above count as errors unless you pass `isError`. Results keep the latency tail (no outlier removal), have no ops/s, and add `requests`, `errors`, `errorRate` and `achievedRps`. Each fork runs for the whole `duration`, so `--compare` takes `forks × duration` per rate.
- For one-off latency rather than load, `Bench.make(name, client.get(url))` works too.

## Resource profiles

Profiles run forks inside Docker with CPU and memory limits, so you can see how code behaves on a smaller machine:

```ts
export default BenchConfig.make({
  profiles: {
    small: { cpus: 1, memory: '512 MiB' },
    large: { cpus: 4, memory: '8 GiB', cpuset: '0-3' },
  },
})
```

```bash
effect-bench run --profile small,large --json
```

Every id gets a `profile` param (`import/parse[profile=small]`), so baselines compare like with like. A suite with `profiles: ['large']` only runs under those. Each fork runs `node:<your Node version>-slim` with the project mounted read-only at the same path; `image` and `dockerArgs` (for example `['-e', 'DATABASE_URL', '--network', 'host']`) override that.

- On macOS and Windows, Docker runs in a Linux VM, so profile numbers are not comparable to native runs; compare profiles with each other, or run them in Linux CI.
- Native addons built for the host OS will not load in the container.
- Inside the container, `localhost` is the container. Reach a database on the host with `host.docker.internal` or `--network host`.
- Starting a container adds about a second per fork.

## Output

`--json` prints one record per line on stdout: a `result` per bench and a final `summary`. Logs go to stderr.

```json
{"type":"result","schemaVersion":3,"status":"ok","id":"userSchema/decode/effect","stats":{"medianNs":858,"p99Ns":943,"opsPerSec":1165161,...},"comparison":{"baseline":"before","change":0.051,"ci":[0.039,0.058],"verdict":"slower","stale":false},"relative":{"baselineId":"userSchema/decode/sync","ratio":5.1}}
{"type":"summary","schemaVersion":3,"total":4,"failed":0,"regressions":1,"budgetsExceeded":0,"stale":0,"exitCode":1}
```

## How verdicts work

The CLI measures each suite in several fresh processes (`--forks`, default 3; 6 with `--rigorous`), interleaved fork by fork so slow drift spreads across suites. Drift between processes — JIT decisions, CPU frequency — is much larger than noise within one run, so each fork's median counts as one observation: the 95% interval for the change is a pooled t-interval on log medians.

`faster`/`slower` only when the whole interval is beyond the noise threshold (`--threshold`, default 3%), `same` when it is inside, `inconclusive` otherwise. On a laptop with 3 forks per side, repeated comparisons of unchanged code gave no false verdicts in 96 tries; a 15% slowdown was flagged every time and a 5% one most of the time (otherwise `inconclusive`). Treat `inconclusive` as "measure more": `--rigorous` or more `--forks`.

`--forks 0` measures in the CLI process, and `Runner.run` does the same when called from code. With a single fork on both sides the interval only sees within-run noise and will overstate confidence.

Exit codes: `0` ok, `1` regression or blown budget, `2` failed bench or error, `3` baseline recorded on another runtime or machine.

## Config

Optional `effect-bench.config.ts` in the working directory:

```ts
import { BenchConfig } from '@effect-bench/cli'

export default BenchConfig.make({
  include: ['**/bench/*.bench.ts'],
  modes: { ci: { samples: 50, minTime: '1 second', forks: 5 } },
  noiseThreshold: 0.05,
})
```

## Packages

- `@effect-bench/core` — DSL, measuring loop, stats, comparison, runner, reporters. No platform imports.
- `@effect-bench/node` — hrtime clock, GC and heap, environment fingerprint, file baseline store.
- `@effect-bench/cli` — `effect-bench` command.

## Known limitations

- Bench files are loaded with Node's built-in type stripping, so they must use erasable TypeScript syntax only.
- Load benches sleep with millisecond resolution; above roughly 1,000 rps, operations start in small bursts rather than evenly.
