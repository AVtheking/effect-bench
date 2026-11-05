import { Context, Data, Effect, Option } from 'effect'
import type { Baseline, BenchResult, Environment, Summary } from './BenchResult.ts'

export interface Clock {
  readonly nowNs: () => number
}

export const BenchClock = Context.Reference<Clock>('effect-bench/BenchClock', {
  defaultValue: () => ({ nowNs: () => performance.now() * 1e6 }),
})

export interface Memory {
  readonly gc: (() => void) | undefined
  readonly heapUsed: (() => number) | undefined
  /** Resident set size of the process, for stream peaks. */
  readonly rss: (() => number) | undefined
}

export const BenchMemory = Context.Reference<Memory>('effect-bench/BenchMemory', {
  defaultValue: () => ({ gc: undefined, heapUsed: undefined, rss: undefined }),
})

export interface PhaseRecorder {
  /** Path of the enclosing phase, empty at the top of a run. */
  readonly path: string
  readonly record: (path: string, ns: number) => void
}

export const BenchPhases = Context.Reference<PhaseRecorder>('effect-bench/BenchPhases', {
  defaultValue: () => ({ path: '', record: () => {} }),
})

export interface EnvironmentProbe {
  readonly fingerprint: Effect.Effect<Environment>
}

export const BenchEnvironment = Context.Reference<EnvironmentProbe>('effect-bench/BenchEnvironment', {
  defaultValue: () => ({
    fingerprint: Effect.succeed({
      runtime: 'unknown',
      runtimeVersion: 'unknown',
      platform: 'unknown',
      arch: 'unknown',
      cpu: 'unknown',
      cpus: 0,
      gitSha: null,
      gitDirty: null,
    }),
  }),
})

export class BaselineError extends Data.TaggedError('BaselineError')<{
  readonly name: string
  readonly message: string
  readonly cause?: unknown
}> {}

export interface Store {
  readonly save: (baseline: Baseline) => Effect.Effect<void, BaselineError>
  readonly load: (name: string) => Effect.Effect<Option.Option<Baseline>, BaselineError>
}

export const makeMemoryStore = (): Store => {
  const baselines = new Map<string, Baseline>()
  return {
    save: baseline => Effect.sync(() => void baselines.set(baseline.name, baseline)),
    load: name => Effect.sync(() => Option.fromUndefinedOr(baselines.get(name))),
  }
}

export const BaselineStore = Context.Reference<Store>('effect-bench/BaselineStore', {
  defaultValue: makeMemoryStore,
})

export interface Reporter {
  readonly onResult: (result: BenchResult) => Effect.Effect<void>
  readonly onEnd: (summary: Summary, results: ReadonlyArray<BenchResult>) => Effect.Effect<void>
}

export const BenchReporter = Context.Reference<Reporter>('effect-bench/BenchReporter', {
  defaultValue: () => ({ onResult: () => Effect.void, onEnd: () => Effect.void }),
})
