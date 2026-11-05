import { Cause, type Context, Data, Duration, Effect, Exit, Layer, Option, type Scope, Stream } from 'effect'
import { type Bench, benchId, type Options, type Size, type Suite } from './Bench.ts'
import type {
  Baseline,
  BaselineEntry,
  BenchResult,
  BudgetCheck,
  Environment,
  FailedResult,
  OkResult,
  RawOk,
  RawResult,
  Stats,
  Summary,
} from './BenchResult.ts'
import { schemaVersion } from './BenchResult.ts'
import { compare } from './Compare.ts'
import { CheckFailed, measure } from './Measure.ts'
import { BaselineError, BaselineStore, BenchEnvironment, BenchReporter } from './Services.ts'
import { compute, formatBytes, formatNs, median } from './Stats.ts'

export interface MeasureOptions {
  /** Only run benches whose id contains this text, or that carry this tag. */
  readonly filter?: string | undefined
  /** Overrides the library defaults; suite and bench options still win. */
  readonly mode?: Options | undefined
}

export interface FinishOptions {
  readonly compare?: string | undefined
  readonly save?: string | undefined
  readonly noiseThreshold?: number | undefined
}

export interface RunOptions extends MeasureOptions, FinishOptions {}

export interface PlannedBench {
  readonly id: string
  readonly suite: string
  readonly name: string
  readonly group: string | null
  readonly params: Bench['params']
  readonly tags: ReadonlyArray<string>
}

export interface RunReport {
  readonly results: ReadonlyArray<BenchResult>
  readonly summary: Summary
}

const defaults = { samples: 30, minTime: '500 millis', warmup: '200 millis', memory: false } satisfies Options

class BenchFailure extends Data.TaggedError('BenchFailure')<{
  readonly phase: FailedResult['phase']
  readonly message: string
}> {}

const toNs = (input: Duration.Input) => Number(Duration.toNanosUnsafe(input))

const bytesPer = { B: 1, KB: 1e3, KiB: 1024, MB: 1e6, MiB: 1024 ** 2, GB: 1e9, GiB: 1024 ** 3 } as const

const toBytes = (size: Size): number => {
  if (typeof size === 'number') return size
  const [amount, unit] = size.split(' ') as [string, keyof typeof bytesPer]
  return Number(amount) * bytesPer[unit]
}

const failWith = (phase: FailedResult['phase']) => (cause: Cause.Cause<unknown>) =>
  new BenchFailure({ phase, message: Cause.pretty(cause) })

const plannedOf = (suite: Suite, bench: Bench, mode: Options | undefined): PlannedBench => ({
  id: benchId(suite.name, bench),
  suite: suite.name,
  name: bench.name,
  group: bench.group?.name ?? null,
  params: bench.params,
  tags: bench.options.tags ?? suite.options.tags ?? mode?.tags ?? [],
})

const matches = (planned: PlannedBench, filter: string | undefined) =>
  filter === undefined || planned.id.includes(filter) || planned.tags.includes(filter)

export const list = (suites: ReadonlyArray<Suite>, filter?: string): ReadonlyArray<PlannedBench> =>
  suites.flatMap(suite =>
    suite.benches.map(bench => plannedOf(suite, bench, undefined)).filter(planned => matches(planned, filter))
  )

const checkBudget = (limits: RawOk['limits'], stats: Stats, heapDeltaBytes: number | null): BudgetCheck | null => {
  if (limits === null) return null
  const violations = [
    ...(limits.p50Ns !== null && stats.medianNs > limits.p50Ns
      ? [`p50 ${formatNs(stats.medianNs)} > ${formatNs(limits.p50Ns)}`]
      : []),
    ...(limits.p99Ns !== null && stats.p99Ns > limits.p99Ns
      ? [`p99 ${formatNs(stats.p99Ns)} > ${formatNs(limits.p99Ns)}`]
      : []),
    ...(limits.heapDeltaBytes !== null && heapDeltaBytes !== null && heapDeltaBytes > limits.heapDeltaBytes
      ? [`heapDelta ${formatBytes(heapDeltaBytes)} > ${formatBytes(limits.heapDeltaBytes)}`]
      : []),
  ]
  return { status: violations.length === 0 ? 'ok' : 'exceeded', violations }
}

const isStale = (current: Environment, recorded: Environment) =>
  current.runtime !== recorded.runtime ||
  current.runtimeVersion !== recorded.runtimeVersion ||
  current.platform !== recorded.platform ||
  current.arch !== recorded.arch ||
  current.cpu !== recorded.cpu

const runBench = Effect.fn('effectBench/runBench')(function* (
  bench: Bench,
  planned: PlannedBench,
  ctx: unknown,
  options: Options
) {
  const operation = yield* bench.prepare(ctx).pipe(Effect.catchCause(cause => Effect.fail(failWith('prepare')(cause))))

  if (bench.check !== undefined && operation._tag !== 'Scenario') {
    const value =
      operation._tag === 'Sync'
        ? yield* Effect.try({ try: operation.run, catch: error => error })
        : operation._tag === 'Effect'
          ? yield* operation.single ?? operation.run
          : operation._tag === 'PerOp'
            ? yield* Effect.flatMap(operation.before, operation.run)
            : yield* Stream.runCount(operation.stream())
    if (!bench.check(value)) {
      return yield* new BenchFailure({ phase: 'check', message: `check rejected the result: ${String(value)}` })
    }
  }

  const measurement = yield* measure(operation, {
    samples: options.samples ?? defaults.samples,
    minTimeNs: toNs(options.minTime ?? defaults.minTime),
    warmupNs: toNs(options.warmup ?? defaults.warmup),
    memory: options.memory === true || options.budget?.heapDelta !== undefined,
  })

  const { budget } = options
  return {
    status: 'ok',
    ...planned,
    relativeTo:
      bench.group === undefined
        ? null
        : benchId(planned.suite, { name: bench.group.baseline, params: bench.params, group: bench.group }),
    samplesNs: measurement.samplesNs,
    batchSize: measurement.batchSize,
    overheadNs: measurement.overheadNs,
    heapDeltaBytes: measurement.heapDeltaBytes,
    metrics: measurement.metrics,
    limits:
      budget === undefined
        ? null
        : {
            p50Ns: budget.p50 === undefined ? null : toNs(budget.p50),
            p99Ns: budget.p99 === undefined ? null : toNs(budget.p99),
            heapDeltaBytes: budget.heapDelta === undefined ? null : toBytes(budget.heapDelta),
          },
  } satisfies RawOk
})

const failureOf = (cause: Cause.Cause<unknown>): BenchFailure => {
  const error = Cause.squash(cause)
  if (error instanceof CheckFailed) return new BenchFailure({ phase: 'check', message: error.message })
  return error instanceof BenchFailure ? error : failWith('run')(cause)
}

export const failed = (planned: PlannedBench, phase: FailedResult['phase'], message: string): FailedResult => ({
  status: 'failed',
  ...planned,
  phase,
  message,
})

/** `suite` already checked that the layer covers what setup and benches need; the erased types only see `any`. */
const provideSuite = <A, E>(effect: Effect.Effect<A, E, any>, context: Context.Context<never>) =>
  Effect.provideContext(effect, context) as Effect.Effect<A, E, Scope.Scope>

const runSuite = Effect.fn('effectBench/runSuite')(function* (
  suite: Suite,
  benches: ReadonlyArray<{ readonly bench: Bench; readonly planned: PlannedBench }>,
  mode: Options | undefined
) {
  const setup = yield* Effect.exit(
    Effect.gen(function* () {
      const context = yield* Layer.build(suite.layer)
      const ctx = yield* provideSuite(suite.setup, context)
      return { context, ctx }
    })
  )
  if (Exit.isFailure(setup)) {
    const message = Cause.pretty(setup.cause)
    return benches.map(({ planned }) => failed(planned, 'setup', message))
  }

  const results: Array<RawResult> = []
  for (const { bench, planned } of benches) {
    const options = { ...defaults, ...bench.defaults, ...mode, ...suite.options, ...bench.options }
    const exit = yield* Effect.exit(
      provideSuite(runBench(bench, planned, setup.value.ctx, options), setup.value.context)
    )
    if (Exit.isSuccess(exit)) results.push(exit.value)
    else {
      const failure = failureOf(exit.cause)
      results.push(failed(planned, failure.phase, failure.message))
    }
  }
  return results
}, Effect.scoped)

export const plan = (suites: ReadonlyArray<Suite>, options: MeasureOptions = {}) =>
  suites.flatMap(suite => {
    const benches = suite.benches
      .map(bench => ({ bench, planned: plannedOf(suite, bench, options.mode) }))
      .filter(({ planned }) => matches(planned, options.filter))
    return benches.length === 0 ? [] : [{ suite, benches }]
  })

/** Measures every matching bench once, in this process. */
export const measureSuites = Effect.fn('effectBench/measureSuites')(function* (
  suites: ReadonlyArray<Suite>,
  options: MeasureOptions = {}
) {
  const results: Array<RawResult> = []
  for (const { suite, benches } of plan(suites, options))
    results.push(...(yield* runSuite(suite, benches, options.mode)))
  return results
})

const merge = (
  runs: ReadonlyArray<RawResult>,
  baseline: Baseline | undefined,
  settings: { readonly stale: boolean; readonly noiseThreshold: number }
): { readonly result: BenchResult; readonly entry: BaselineEntry | undefined } => {
  const failure = runs.find(run => run.status === 'failed')
  if (failure !== undefined) return { result: failure, entry: undefined }
  const oks = runs as ReadonlyArray<RawOk>
  const first = oks[0]!
  const forks = oks.map(run => run.samplesNs)
  const stats = compute(forks.flat())
  const heap = oks.flatMap(run => (run.heapDeltaBytes === null ? [] : [run.heapDeltaBytes]))
  const recorded = baseline?.entries.find(entry => entry.id === first.id)
  const { relativeTo, samplesNs, limits, metrics: _, ...identity } = first
  const metricKeys = [...new Set(oks.flatMap(run => Object.keys(run.metrics ?? {})))]
  const heapDeltaBytes = heap.length === 0 ? null : median(heap)

  return {
    result: {
      ...identity,
      stats,
      forks: forks.length,
      batchSize: median(oks.map(run => run.batchSize)),
      overheadNs: median(oks.map(run => run.overheadNs)),
      heapDeltaBytes,
      metrics:
        metricKeys.length === 0
          ? null
          : Object.fromEntries(metricKeys.map(key => [key, median(oks.flatMap(run => run.metrics?.[key] ?? []))])),
      budget: checkBudget(limits, stats, heapDeltaBytes),
      comparison:
        recorded === undefined || baseline === undefined
          ? null
          : {
              baseline: baseline.name,
              baselineMedianNs: recorded.stats.medianNs,
              stale: settings.stale,
              ...compare(forks, recorded.forks, { noiseThreshold: settings.noiseThreshold }),
            },
      relative: null,
    },
    entry: { id: first.id, forks, stats },
  }
}

const withRelative = (results: ReadonlyArray<BenchResult>, raws: ReadonlyArray<RawResult>) =>
  results.map((result, index) => {
    const raw = raws[index]
    if (result.status !== 'ok' || raw?.status !== 'ok' || raw.relativeTo === null) return result
    const reference = results.find(candidate => candidate.id === raw.relativeTo)
    if (reference?.status !== 'ok' || reference.stats.medianNs === 0) return result
    return {
      ...result,
      relative: { baselineId: reference.id, ratio: result.stats.medianNs / reference.stats.medianNs },
    }
  })

export const summarize = (results: ReadonlyArray<BenchResult>): Summary => {
  const ok = results.filter(result => result.status === 'ok')
  const failedCount = results.length - ok.length
  const regressions = ok.filter(result => result.comparison?.verdict === 'slower').length
  const budgetsExceeded = ok.filter(result => result.budget?.status === 'exceeded').length
  const stale = ok.filter(result => result.comparison?.stale === true).length
  return {
    total: results.length,
    failed: failedCount,
    regressions,
    budgetsExceeded,
    stale,
    exitCode: failedCount > 0 ? 2 : regressions + budgetsExceeded > 0 ? 1 : stale > 0 ? 3 : 0,
  }
}

/** Merges per-fork measurements, compares against a baseline, reports and optionally saves. */
export const finish = Effect.fn('effectBench/finish')(function* (
  forks: ReadonlyArray<ReadonlyArray<RawResult>>,
  options: FinishOptions = {}
) {
  const reporter = yield* BenchReporter
  const store = yield* BaselineStore
  const environment = yield* (yield* BenchEnvironment).fingerprint

  const baseline =
    options.compare === undefined
      ? undefined
      : (Option.getOrUndefined(yield* store.load(options.compare)) ??
        (yield* new BaselineError({ name: options.compare, message: `Baseline "${options.compare}" not found.` })))
  const settings = {
    stale: baseline !== undefined && isStale(environment, baseline.environment),
    noiseThreshold: options.noiseThreshold ?? 0.03,
  }

  const byId = new Map<string, Array<RawResult>>()
  for (const fork of forks) for (const raw of fork) byId.set(raw.id, [...(byId.get(raw.id) ?? []), raw])
  const raws = [...byId.values()].map(runs => runs[0]!)
  const merged = [...byId.values()].map(runs => merge(runs, baseline, settings))
  const results = withRelative(
    merged.map(({ result }) => result),
    raws
  )
  for (const result of results) yield* reporter.onResult(result)

  if (options.save !== undefined) {
    yield* store.save({
      schemaVersion,
      name: options.save,
      createdAt: new Date().toISOString(),
      environment,
      entries: merged.flatMap(({ entry }) => (entry === undefined ? [] : [entry])),
    })
  }

  const summary = summarize(results)
  yield* reporter.onEnd(summary, results)
  return { results, summary } satisfies RunReport
})

/** Measures in this process (one fork) and finishes. Use the CLI for fresh-process forks. */
export const run = (suites: ReadonlyArray<Suite>, options: RunOptions = {}) =>
  Effect.flatMap(measureSuites(suites, options), raws => finish([raws], options))
