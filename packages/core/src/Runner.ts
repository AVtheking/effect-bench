import { Cause, type Context, Data, Duration, Effect, Exit, Layer, Option, type Scope } from 'effect'
import { type Bench, benchId, type Options, type Suite } from './Bench.ts'
import type {
  Baseline,
  BenchResult,
  BudgetCheck,
  Comparison,
  Environment,
  FailedResult,
  OkResult,
  Summary,
} from './BenchResult.ts'
import { schemaVersion } from './BenchResult.ts'
import { compare } from './Compare.ts'
import { measure } from './Measure.ts'
import { BaselineError, BaselineStore, BenchEnvironment, BenchReporter } from './Services.ts'
import { compute, formatNs } from './Stats.ts'

export interface RunOptions {
  /** Only run benches whose id contains this text. */
  readonly filter?: string | undefined
  /** Overrides the library defaults; suite and bench options still win. */
  readonly mode?: Options | undefined
  readonly compare?: string | undefined
  readonly save?: string | undefined
  readonly noiseThreshold?: number | undefined
}

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

const toNs = (input: Duration.Input) => Number(Duration.toNanosUnsafe(input))

const checkBudget = (options: Options, stats: OkResult['stats']): BudgetCheck | null => {
  if (options.budget === undefined) return null
  const violations = (['p50', 'p99'] as const).flatMap(key => {
    const limit = options.budget?.[key]
    if (limit === undefined) return []
    const actual = key === 'p50' ? stats.medianNs : stats.p99Ns
    return actual > toNs(limit) ? [`${key} ${formatNs(actual)} > ${formatNs(toNs(limit))}`] : []
  })
  return { status: violations.length === 0 ? 'ok' : 'exceeded', violations }
}

const isStale = (current: Environment, recorded: Environment) =>
  current.runtime !== recorded.runtime ||
  current.runtimeVersion !== recorded.runtimeVersion ||
  current.platform !== recorded.platform ||
  current.arch !== recorded.arch ||
  current.cpu !== recorded.cpu

interface Measured {
  readonly result: BenchResult
  readonly samplesNs: ReadonlyArray<number>
}

const runBench = Effect.fn('effectBench/runBench')(function* (
  bench: Bench,
  planned: PlannedBench,
  ctx: unknown,
  settings: {
    readonly options: Options
    readonly baseline: Baseline | undefined
    readonly stale: boolean
    readonly noiseThreshold: number
  }
) {
  const operation = yield* bench.prepare(ctx).pipe(Effect.catchCause(cause => Effect.fail(failWith('prepare')(cause))))

  if (bench.check !== undefined) {
    const value =
      operation._tag === 'Sync'
        ? yield* Effect.try({ try: operation.run, catch: error => error })
        : yield* operation.run
    if (!bench.check(value)) {
      return yield* new BenchFailure({ phase: 'check', message: `check rejected the result: ${String(value)}` })
    }
  }

  const options = settings.options
  const measurement = yield* measure(operation, {
    samples: options.samples ?? defaults.samples,
    minTimeNs: toNs(options.minTime ?? defaults.minTime),
    warmupNs: toNs(options.warmup ?? defaults.warmup),
    memory: options.memory ?? defaults.memory,
  })
  const stats = compute(measurement.samplesNs)

  const entry = settings.baseline?.entries.find(candidate => candidate.id === planned.id)
  const comparison: Comparison | null =
    entry === undefined || settings.baseline === undefined
      ? null
      : {
          baseline: settings.baseline.name,
          baselineMedianNs: entry.stats.medianNs,
          stale: settings.stale,
          ...compare(measurement.samplesNs, entry.samplesNs, { noiseThreshold: settings.noiseThreshold }),
        }

  return {
    result: {
      status: 'ok',
      ...planned,
      stats,
      batchSize: measurement.batchSize,
      overheadNs: measurement.overheadNs,
      heapDeltaBytes: measurement.heapDeltaBytes,
      budget: checkBudget(options, stats),
      comparison,
      relative: null,
    },
    samplesNs: measurement.samplesNs,
  } satisfies Measured
})

const failureOf = (cause: Cause.Cause<unknown>): BenchFailure => {
  const error = Cause.squash(cause)
  return error instanceof BenchFailure ? error : failWith('run')(cause)
}

const withRelative = (measured: ReadonlyArray<Measured>, benches: ReadonlyArray<Bench>): ReadonlyArray<Measured> =>
  measured.map((item, index) => {
    const group = benches[index]?.group
    if (item.result.status !== 'ok' || group === undefined) return item
    const reference = measured.find(
      (candidate, candidateIndex) =>
        benches[candidateIndex]?.group?.name === group.name && benches[candidateIndex]?.name === group.baseline
    )?.result
    if (reference?.status !== 'ok' || reference.stats.medianNs === 0) return item
    return {
      ...item,
      result: {
        ...item.result,
        relative: { baselineId: reference.id, ratio: item.result.stats.medianNs / reference.stats.medianNs },
      },
    }
  })

const failed = (planned: PlannedBench, failure: BenchFailure): Measured => ({
  result: { status: 'failed', ...planned, phase: failure.phase, message: failure.message },
  samplesNs: [],
})

/** `suite` already checked that the layer covers what setup and benches need; the erased types only see `any`. */
const provideSuite = <A, E>(effect: Effect.Effect<A, E, any>, context: Context.Context<never>) =>
  Effect.provideContext(effect, context) as Effect.Effect<A, E, Scope.Scope>

const runSuite = Effect.fn('effectBench/runSuite')(function* (
  suite: Suite,
  benches: ReadonlyArray<{ readonly bench: Bench; readonly planned: PlannedBench }>,
  settings: Omit<Parameters<typeof runBench>[3], 'options'> & { readonly mode: Options | undefined }
) {
  const setup = yield* Effect.exit(
    Effect.gen(function* () {
      const context = yield* Layer.build(suite.layer)
      const ctx = yield* provideSuite(suite.setup, context)
      return { context, ctx }
    })
  )
  if (Exit.isFailure(setup)) {
    const failure = failWith('setup')(setup.cause)
    return benches.map(({ planned }) => failed(planned, failure))
  }

  const measured: Array<Measured> = []
  for (const { bench, planned } of benches) {
    const exit = yield* Effect.exit(
      runBench(bench, planned, setup.value.ctx, {
        ...settings,
        options: { ...defaults, ...settings.mode, ...suite.options, ...bench.options },
      }).pipe(effect => provideSuite(effect, setup.value.context))
    )
    measured.push(Exit.isSuccess(exit) ? exit.value : failed(planned, failureOf(exit.cause)))
  }
  return withRelative(
    measured,
    benches.map(({ bench }) => bench)
  )
}, Effect.scoped)

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

export const run = Effect.fn('effectBench/run')(function* (suites: ReadonlyArray<Suite>, options: RunOptions = {}) {
  const reporter = yield* BenchReporter
  const store = yield* BaselineStore
  const environment = yield* (yield* BenchEnvironment).fingerprint

  const baseline =
    options.compare === undefined
      ? undefined
      : (Option.getOrUndefined(yield* store.load(options.compare)) ??
        (yield* new BaselineError({ name: options.compare, message: `Baseline "${options.compare}" not found.` })))

  const settings = {
    baseline,
    stale: baseline !== undefined && isStale(environment, baseline.environment),
    noiseThreshold: options.noiseThreshold ?? 0.03,
    mode: options.mode,
  }

  const measured: Array<Measured> = []
  for (const suite of suites) {
    const benches = suite.benches
      .map(bench => ({ bench, planned: plannedOf(suite, bench, options.mode) }))
      .filter(({ planned }) => matches(planned, options.filter))
    if (benches.length === 0) continue
    const suiteResults = yield* runSuite(suite, benches, settings)
    for (const item of suiteResults) yield* reporter.onResult(item.result)
    measured.push(...suiteResults)
  }

  if (options.save !== undefined) {
    yield* store.save({
      schemaVersion,
      name: options.save,
      createdAt: new Date().toISOString(),
      environment,
      entries: measured.flatMap(({ result, samplesNs }) =>
        result.status === 'ok' ? [{ id: result.id, samplesNs, stats: result.stats }] : []
      ),
    })
  }

  const results = measured.map(({ result }) => result)
  const summary = summarize(results)
  yield* reporter.onEnd(summary, results)
  return { results, summary } satisfies RunReport
})
