import type { Duration, Scope } from 'effect'
import { Effect, Layer } from 'effect'

export type ParamValue = string | number | boolean

export type Params = Readonly<Record<string, ParamValue>>

export interface Budget {
  readonly p50?: Duration.Input
  readonly p99?: Duration.Input
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

export type Operation =
  | { readonly _tag: 'Sync'; readonly run: () => unknown }
  | { readonly _tag: 'Effect'; readonly run: Effect.Effect<unknown, unknown> }

export interface Bench<in Ctx = any, out R = any> {
  readonly _tag: 'Bench'
  readonly name: string
  readonly params: Params
  readonly group: { readonly name: string; readonly baseline: string } | undefined
  readonly options: Options
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

export interface SuiteOptions<Ctx, ROut> extends Options {
  readonly layer?: Layer.Layer<ROut, unknown>
  readonly setup?: Effect.Effect<Ctx, unknown, ROut | Scope.Scope>
}

type Entry<Ctx, R> = Bench<Ctx, R> | ReadonlyArray<Bench<Ctx, R>>

export const suite =
  <Ctx = undefined, ROut = never>(name: string, options: SuiteOptions<Ctx, ROut> = {}) =>
  (...entries: ReadonlyArray<Entry<Ctx, ROut>>): Suite => {
    const { layer, setup, ...defaults } = options
    return {
      _tag: 'Suite',
      name,
      layer: layer ?? Layer.empty,
      setup: setup ?? Effect.undefined,
      options: defaults,
      benches: entries.flat(),
    }
  }

type BenchOptions<A> = Options & { readonly check?: (value: A) => boolean }

const makeBench = <Ctx, R>(
  name: string,
  prepare: (ctx: Ctx) => Effect.Effect<Operation, unknown, R>,
  { check, ...options }: BenchOptions<any>,
  params: Params = {}
): Bench<Ctx, R> => ({ _tag: 'Bench', name, params, group: undefined, options, check, prepare })

export const make = <Ctx = unknown, A = unknown, E = never, R = never>(
  name: string,
  run: Effect.Effect<A, E, R> | ((ctx: Ctx) => Effect.Effect<A, E, R>),
  options: BenchOptions<A> = {}
): Bench<Ctx, R> =>
  makeBench(
    name,
    ctx =>
      Effect.map(Effect.context<R>(), context => ({
        _tag: 'Effect' as const,
        run: Effect.provideContext(Effect.isEffect(run) ? run : run(ctx), context),
      })),
    options
  )

export const sync = <Ctx = unknown, A = unknown>(
  name: string,
  run: (ctx: Ctx) => A,
  options: BenchOptions<A> = {}
): Bench<Ctx, never> => makeBench(name, ctx => Effect.succeed({ _tag: 'Sync', run: () => run(ctx) }), options)

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

export const params: {
  <const M extends Matrix, Ctx = unknown, I = ParamsOf<M>, A = unknown, E = never, R = never>(
    name: string,
    matrix: M,
    spec: ParamsPrepare<M, Ctx, I, R> &
      BenchOptions<A> & { readonly run: (input: I, ctx: Ctx) => Effect.Effect<A, E, R> }
  ): ReadonlyArray<Bench<Ctx, R>>
  <const M extends Matrix, Ctx = unknown, I = ParamsOf<M>, A = unknown, R = never>(
    name: string,
    matrix: M,
    spec: ParamsPrepare<M, Ctx, I, R> & BenchOptions<A> & { readonly sync: (input: I, ctx: Ctx) => A }
  ): ReadonlyArray<Bench<Ctx, R>>
} = (
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
): ReadonlyArray<Bench<any, any>> =>
  combinations(matrix).map(combo =>
    makeBench(
      name,
      ctx =>
        Effect.gen(function* () {
          const input = prepare === undefined ? combo : yield* prepare(combo, ctx)
          if (runSync !== undefined) return { _tag: 'Sync' as const, run: () => runSync(input, ctx) }
          const context = yield* Effect.context<unknown>()
          return { _tag: 'Effect' as const, run: Effect.provideContext(run!(input, ctx), context) }
        }),
      options,
      combo
    )
  )

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
