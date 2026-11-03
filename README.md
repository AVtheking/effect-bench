# effect-bench

Benchmarks for [Effect](https://effect.website) code, with JSON output and baseline verdicts built for agents and CI.

```ts
// bench/schema.bench.ts
import { Bench } from '@effect-bench/core'
import { Effect } from 'effect'

export default Bench.suite('workflowCompiler', { layer: NodeRegistry.layer })(
  Bench.params('compile', { nodes: [10, 100, 1000] }, {
    prepare: ({ nodes }) => Effect.succeed(makeDraft(nodes)),   // untimed
    run: draft => compile(draft),                                // timed
  }),
  Bench.group('decode', { baseline: 'sync' })(
    Bench.sync('sync', () => decodeSync(lead)),
    Bench.make('effect', () => decodeEffect(lead)),
  ),
  Bench.sync('encode', () => encode(payload), { budget: { p99: '5 millis' } }),
)
```

```bash
effect-bench list
effect-bench run --save before          # store a baseline
effect-bench run --compare before --json
effect-bench check --compare before     # exit 1 on a regression or blown budget
```

## Writing benches

| Constructor | Measures |
| --- | --- |
| `Bench.make(name, effect)` | re-runs one Effect value |
| `Bench.make(name, ctx => effect)` | builds and runs a fresh Effect per operation |
| `Bench.sync(name, ctx => value)` | a plain function |
| `Bench.params(name, matrix, { prepare?, run \| sync })` | one bench per combination, ids like `compile[nodes=100]` |
| `Bench.group(name, { baseline })(...)` | alternatives, reported as a ratio to the baseline |

`Bench.suite(name, { layer, setup, ...options })` builds `layer` once per suite and runs `setup` in the suite's scope; its result is the `ctx` each bench receives. Benches can only use services the layer provides — anything else is a type error.

Options (suite or bench): `samples`, `minTime`, `warmup`, `memory` (GC + heap delta per sample), `budget: { p50, p99 }`, `tags`, and `check` (validates one result before timing).

## Output

`--json` prints one record per line on stdout: a `result` per bench and a final `summary`. Logs go to stderr.

```json
{"type":"result","schemaVersion":1,"status":"ok","id":"leadSchema/decode/effect","stats":{"medianNs":858,"p99Ns":943,"opsPerSec":1165161,...},"comparison":{"baseline":"before","change":0.051,"ci":[0.039,0.058],"verdict":"slower","stale":false},"relative":{"baselineId":"leadSchema/decode/sync","ratio":5.1}}
{"type":"summary","schemaVersion":1,"total":4,"failed":0,"regressions":1,"budgetsExceeded":0,"stale":0,"exitCode":1}
```

Verdicts come from a bootstrap 95% confidence interval on the change in median: `faster`/`slower` only when the whole interval is beyond the noise threshold (`--threshold`, default 3%), `same` when it is inside, `inconclusive` otherwise.

Exit codes: `0` ok, `1` regression or blown budget, `2` failed bench or error, `3` baseline recorded on another runtime or machine.

## Config

Optional `effect-bench.config.ts` in the working directory:

```ts
import { BenchConfig } from '@effect-bench/cli'

export default BenchConfig.make({
  include: ['**/bench/*.bench.ts'],
  modes: { ci: { samples: 50, minTime: '1 second' } },
  noiseThreshold: 0.05,
})
```

## Packages

- `@effect-bench/core` — DSL, measuring loop, stats, comparison, runner, reporters. No platform imports.
- `@effect-bench/node` — hrtime clock, GC and heap, environment fingerprint, file baseline store.
- `@effect-bench/cli` — `effect-bench` command.

## Known limitations

- Verdicts only see noise within one run. Re-running unchanged code can show a few percent of drift (JIT state, CPU frequency) that the interval does not cover, so a `slower` verdict under ~5–10% on `--quick` is not trustworthy yet. Running each suite in several fresh processes is the planned fix.
- Bench files are loaded with Node's built-in type stripping, so they must use erasable TypeScript syntax only.
