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

`Bench.suite(name, { layer, setup, ...options })` builds `layer` once per suite and runs `setup` in the suite's scope; its result is the `ctx` each bench receives. Benches can only use services the layer provides — anything else is a type error.

Options (suite or bench): `samples`, `minTime`, `warmup`, `memory` (GC + heap delta per sample), `budget: { p50, p99, heapDelta }`, `tags`, and `check` (validates one result before timing). A `heapDelta` budget such as `'2 MiB'` turns on `memory`. Scenarios default to 10 samples with no warmup time, streams to 10 samples.

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

Streams and scenarios add a `metrics` record to each result; the key suffix gives the unit (`firstItemNs`, `peakRssBytes`, `phase:parseNs`). `peakRss` is the whole process's resident memory, so earlier benches in the same process count toward it.

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
