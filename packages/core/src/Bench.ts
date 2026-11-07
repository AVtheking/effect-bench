import type { Duration, Scope } from 'effect'
import { Data, Effect, Layer, Stream } from 'effect'
import { BenchClock, BenchPhases } from './Services.ts'

export type ParamValue = string | number | boolean

export type Params = Readonly<Record<string, ParamValue>>

export type Size = number | `${number} ${'B' | 'KB' | 'KiB' | 'MB' | 'MiB' | 'GB' | 'GiB'}`

export interface Budget {
  readonly p50?: Duration.Input
  readonly p99?: Duration.Input
  /** Heap growth per operation. Setting it turns on `memory`. */
  readonly heapDelta?: Size
}

export interface Options {
  /** Minimum number of samples to collect. */
  readonly samples?: number
  /** Keep sampling until at least this much time has passed. */
  readonly minTime?: Duration.Input
  readonly warmup?: Duration.Input
  /** Force a GC before every sample and record the heap delta. Needs `--expose-gc`. */
  readonly memory?: boolean
  readonly budget?: Budget
  readonly tags?: ReadonlyArray<string>
}

export type Operation = Data.TaggedEnum<{
  Sync: { readonly run: () => unknown }
  Effect: {
    readonly run: Effect.Effect<unknown, unknown>
    /** Operations one run performs; stats are reported per operation. */
    readonly units?: number
    /** A single operation, for `check`, when `run` performs several. */
    readonly single?: Effect.Effect<unknown, unknown>
  }
  PerOp: {
    readonly before: Effect.Effect<unknown, unknown>
    readonly run: (input: unknown) => Effect.Effect<unknown, unknown>
  }
  Stream: { readonly stream: () => Stream.Stream<unknown, unknown> }
  Scenario: {
    readonly before: Effect.Effect<unknown, unknown> | undefined
    readonly run: (input: unknown) => Effect.Effect<unknown, unknown>
    readonly verify: ((value: unknown) => boolean) | undefined
  }
}>

export const Operation = Data.taggedEnum<Operation>()

export interface Bench<in Ctx = any, out R = any> {
  readonly _tag: 'Bench'
  readonly name: string
  readonly params: Params
  readonly group: { readonly name: string; readonly baseline: string } | undefined
  readonly options: Options
  /** Defaults for this kind of bench; mode, suite and bench options override them. */
  readonly defaults: Options
  readonly check: ((value: unknown) => boolean) | undefined
  readonly prepare: (ctx: Ctx) => Effect.Effect<Operation, unknown, R>
}

/** Type relations between layer, setup and benches are enforced by `suite`; the runner only needs the erased shape. */
export interface Suite {
  readonly _tag: 'Suite'
  readonly name: string
  readonly layer: Layer.Layer<never, unknown>
  readonly setup: Effect.Effect<unknown, unknown, any>
  readonly options: Options
  readonly benches: ReadonlyArray<Bench>
}

export type Definition = Bench | Suite

export const Definition = Data.taggedEnum<Definition>()

export interface SuiteOptions<Ctx, ROut> extends Options {
  readonly layer?: Layer.Layer<ROut, unknown>
  readonly setup?: Effect.Effect<Ctx, unknown, ROut | Scope.Scope>
}

type Entry<Ctx, R> = Bench<Ctx, R> | ReadonlyArray<Bench<Ctx, R>>

export const suite =
  <Ctx = undefined, ROut = never>(name: string, options: SuiteOptions<Ctx, ROut> = {}) =>
  (...entries: ReadonlyArray<Entry<Ctx, ROut>>): Suite => {
    const { layer, setup, ...defaults } = options
    return Definition.Suite({
      name,
      layer: layer ?? Layer.empty,
      setup: setup ?? Effect.undefined,
      options: defaults,
      benches: entries.flat(),
    })
  }

type BenchOptions<A> = Options & { readonly check?: (value: A) => boolean }

const makeBench = <Ctx, R>(
  name: string,
  prepare: (ctx: Ctx) => Effect.Effect<Operation, unknown, R>,
  { check, ...options }: BenchOptions<any>,
  { params = {}, defaults = {} }: { readonly params?: Params; readonly defaults?: Options } = {}
): Bench<Ctx, R> => Definition.Bench({ name, params, group: undefined, options, defaults, check, prepare })

export interface Spec<Ctx, I, B, A, E, R> extends BenchOptions<A> {
  /** Runs once, untimed. */
  readonly prepare?: (ctx: Ctx) => Effect.Effect<I, unknown, R>
  /** Runs before every operation, untimed; `run` receives its value. */
  readonly before?: (input: I, ctx: Ctx) => Effect.Effect<B, unknown, R>
  readonly run: (input: B, ctx: Ctx) => Effect.Effect<A, E, R>
}

/**
 * An Effect value is re-run as is; a function is called for every operation, so building the Effect is measured too.
 */
export function make<Ctx = unknown, A = unknown, E = never, R = never>(
  name: string,
  run: Effect.Effect<A, E, R> | ((ctx: Ctx) => Effect.Effect<A, E, R>),
  options?: BenchOptions<A>
): Bench<Ctx, R>
export function make<Ctx = unknown, I = undefined, B = I, A = unknown, E = never, R = never>(
  name: string,
  spec: Spec<Ctx, I, B, A, E, R>
): Bench<Ctx, R>
export function make(
  name: string,
  run:
    | Effect.Effect<unknown, unknown, unknown>
    | ((ctx: unknown) => Effect.Effect<unknown, unknown, unknown>)
    | Spec<unknown, unknown, unknown, unknown, unknown, unknown>,
  options: BenchOptions<unknown> = {}
): Bench<any, any> {
  if (Effect.isEffect(run) || typeof run === 'function') {
    return makeBench(
      name,
      (ctx: unknown) =>
        Effect.map(Effect.context<unknown>(), context =>
          Operation.Effect({
            run: Effect.provideContext(Effect.isEffect(run) ? run : Effect.suspend(() => run(ctx)), context),
          })
        ),
      options
    )
  }
  const { prepare, before, run: runOne, ...specOptions } = run
  return makeBench(
    name,
    (ctx: unknown) =>
      Effect.gen(function* () {
        const input = prepare === undefined ? undefined : yield* prepare(ctx)
        const context = yield* Effect.context<unknown>()
        if (before === undefined) {
          return Operation.Effect({
            run: Effect.provideContext(
              Effect.suspend(() => runOne(input, ctx)),
              context
            ),
          })
        }
        return Operation.PerOp({
          before: Effect.provideContext(
            Effect.suspend(() => before(input, ctx)),
            context
          ),
          run: (value: unknown) => Effect.provideContext(runOne(value, ctx), context),
        })
      }),
    specOptions
  )
}

export const sync = <Ctx = unknown, A = unknown>(
  name: string,
  run: (ctx: Ctx) => A,
  options: BenchOptions<A> = {}
): Bench<Ctx, never> => makeBench(name, ctx => Effect.succeed(Operation.Sync({ run: () => run(ctx) })), options)

type Matrix = Readonly<Record<string, ReadonlyArray<ParamValue>>>

export type ParamsOf<M extends Matrix> = { readonly [K in keyof M]: M[K][number] }

const combinations = <M extends Matrix>(matrix: M): ReadonlyArray<ParamsOf<M>> =>
  Object.entries(matrix).reduce<ReadonlyArray<Record<string, ParamValue>>>(
    (acc, [key, values]) => acc.flatMap(combo => values.map(value => ({ ...combo, [key]: value }))),
    [{}]
  ) as ReadonlyArray<ParamsOf<M>>

interface ParamsPrepare<M extends Matrix, Ctx, I, R> {
  readonly prepare?: (params: ParamsOf<M>, ctx: Ctx) => Effect.Effect<I, unknown, R>
}

export function params<const M extends Matrix, Ctx = unknown, I = ParamsOf<M>, A = unknown, E = never, R = never>(
  name: string,
  matrix: M,
  spec: ParamsPrepare<M, Ctx, I, R> & BenchOptions<A> & { readonly run: (input: I, ctx: Ctx) => Effect.Effect<A, E, R> }
): ReadonlyArray<Bench<Ctx, R>>
export function params<const M extends Matrix, Ctx = unknown, I = ParamsOf<M>, A = unknown, R = never>(
  name: string,
  matrix: M,
  spec: ParamsPrepare<M, Ctx, I, R> & BenchOptions<A> & { readonly sync: (input: I, ctx: Ctx) => A }
): ReadonlyArray<Bench<Ctx, R>>
export function params(
  name: string,
  matrix: Matrix,
  {
    prepare,
    run,
    sync: runSync,
    ...options
  }: {
    readonly prepare?: (params: Params, ctx: unknown) => Effect.Effect<unknown, unknown, unknown>
    readonly run?: (input: unknown, ctx: unknown) => Effect.Effect<unknown, unknown, unknown>
    readonly sync?: (input: unknown, ctx: unknown) => unknown
  } & BenchOptions<unknown>
): ReadonlyArray<Bench<any, any>> {
  return combinations(matrix).map(combo =>
    makeBench(
      name,
      (ctx: unknown) =>
        Effect.gen(function* () {
          const input = prepare === undefined ? combo : yield* prepare(combo, ctx)
          if (runSync !== undefined) return Operation.Sync({ run: () => runSync(input, ctx) })
          const context = yield* Effect.context<unknown>()
          return Operation.Effect({ run: Effect.provideContext(run!(input, ctx), context) })
        }),
      options,
      { params: combo }
    )
  )
}

export interface ThroughputSpec<Ctx, I, A, E, R> extends BenchOptions<A> {
  /** Operations per run; stats are reported per operation. */
  readonly ops: number
  /** Fibers running operations at once. An array makes one bench per value. */
  readonly concurrency: number | ReadonlyArray<number>
  readonly prepare?: (ctx: Ctx) => Effect.Effect<I, unknown, R>
  readonly run: (index: number, input: I, ctx: Ctx) => Effect.Effect<A, E, R>
}

/** Runs `ops` operations with the given concurrency; ids carry it, e.g. `enqueue[concurrency=50]`. */
export const throughput = <Ctx = unknown, I = undefined, A = unknown, E = never, R = never>(
  name: string,
  { ops, concurrency, prepare, run, ...options }: ThroughputSpec<Ctx, I, A, E, R>
): ReadonlyArray<Bench<Ctx, R>> => {
  const indexes = Array.from({ length: ops }, (_, index) => index)
  return (typeof concurrency === 'number' ? [concurrency] : concurrency).map(fibers =>
    makeBench(
      name,
      (ctx: Ctx) =>
        Effect.gen(function* () {
          const input = (prepare === undefined ? undefined : yield* prepare(ctx)) as I
          const context = yield* Effect.context<R>()
          return Operation.Effect({
            units: ops,
            single: Effect.provideContext(
              Effect.suspend(() => run(0, input, ctx)),
              context
            ),
            run: Effect.provideContext(
              Effect.forEach(indexes, index => run(index, input, ctx), { concurrency: fibers, discard: true }),
              context
            ),
          })
        }),
      options,
      { params: { concurrency: fibers } }
    )
  )
}

export interface StreamSpec<Ctx, I, A, E, R> extends Options {
  readonly prepare?: (ctx: Ctx) => Effect.Effect<I, unknown, R>
  /** Built fresh for every run. */
  readonly stream: (input: I, ctx: Ctx) => Stream.Stream<A, E, R>
}

/** Runs the stream to the end; stats are per item, with time to first item and peak RSS as metrics. */
export const stream = <Ctx = unknown, I = undefined, A = unknown, E = never, R = never>(
  name: string,
  { prepare, stream: build, ...options }: StreamSpec<Ctx, I, A, E, R>
): Bench<Ctx, R> =>
  makeBench(
    name,
    (ctx: Ctx) =>
      Effect.gen(function* () {
        const input = (prepare === undefined ? undefined : yield* prepare(ctx)) as I
        const context = yield* Effect.context<R>()
        return Operation.Stream({ stream: () => Stream.provideContext(build(input, ctx), context) })
      }),
    options,
    { defaults: { samples: 10 } }
  )

export interface ScenarioSpec<Ctx, I, B, A, E, R> extends Options {
  /** Runs once, untimed. */
  readonly prepare?: (ctx: Ctx) => Effect.Effect<I, unknown, R>
  /** Runs before every run, untimed; `run` receives its value. */
  readonly before?: (input: I, ctx: Ctx) => Effect.Effect<B, unknown, R>
  readonly run: (input: B, ctx: Ctx) => Effect.Effect<A, E, R>
  /** Checked after every run, untimed. */
  readonly verify?: (value: A) => boolean
}

/** A longer flow timed once per sample, with `Bench.phase` timings as metrics. */
export const scenario = <Ctx = unknown, I = undefined, B = I, A = unknown, E = never, R = never>(
  name: string,
  { prepare, before, run, verify, ...options }: ScenarioSpec<Ctx, I, B, A, E, R>
): Bench<Ctx, R> =>
  makeBench(
    name,
    (ctx: Ctx) =>
      Effect.gen(function* () {
        const input = (prepare === undefined ? undefined : yield* prepare(ctx)) as I
        const context = yield* Effect.context<R>()
        return Operation.Scenario({
          before:
            before === undefined
              ? undefined
              : Effect.provideContext(
                  Effect.suspend(() => before(input, ctx)),
                  context
                ),
          run: (value: unknown) =>
            Effect.provideContext(
              Effect.suspend(() => run((before === undefined ? input : value) as B, ctx)),
              context
            ),
          verify: verify as ((value: unknown) => boolean) | undefined,
        })
      }),
    options,
    { defaults: { samples: 10, minTime: 0, warmup: 0 } }
  )

/** Times part of a scenario. Nested phases are reported as `outer/inner`; outside a scenario it just runs the effect. */
export const phase = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const recorder = yield* BenchPhases
    const clock = yield* BenchClock
    const path = recorder.path === '' ? name : `${recorder.path}/${name}`
    const startedAt = clock.nowNs()
    return yield* effect.pipe(
      Effect.provideService(BenchPhases, { ...recorder, path }),
      Effect.ensuring(Effect.sync(() => recorder.record(path, clock.nowNs() - startedAt)))
    )
  })

export const group =
  (name: string, options: { readonly baseline: string }) =>
  <Ctx, R>(...entries: ReadonlyArray<Entry<Ctx, R>>): ReadonlyArray<Bench<Ctx, R>> =>
    entries.flat().map(bench => ({ ...bench, group: { name, baseline: options.baseline } }))

const paramsSuffix = (params: Params): string => {
  const entries = Object.entries(params)
  return entries.length === 0 ? '' : `[${entries.map(([key, value]) => `${key}=${value}`).join(',')}]`
}

export const benchId = (suiteName: string, bench: Pick<Bench, 'name' | 'params' | 'group'>): string =>
  [suiteName, bench.group?.name, `${bench.name}${paramsSuffix(bench.params)}`].filter(Boolean).join('/')
