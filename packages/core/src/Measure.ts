import { Data, Effect, Stream } from 'effect'
import type { Operation } from './Bench.ts'
import { BenchClock, BenchMemory, BenchPhases, type Clock, type Memory } from './Services.ts'
import { median } from './Stats.ts'

export interface MeasureOptions {
  readonly samples: number
  readonly minTimeNs: number
  readonly warmupNs: number
  readonly memory: boolean
  /** Batches are sized so one sample takes at least this long, keeping timer resolution out of the result. */
  readonly targetSampleNs?: number
  readonly maxSamples?: number
}

export interface Measurement {
  /** Per-operation time of each sample, with batch overhead subtracted. */
  readonly samplesNs: ReadonlyArray<number>
  readonly batchSize: number
  readonly overheadNs: number
  readonly heapDeltaBytes: number | null
  readonly metrics: Readonly<Record<string, number>> | null
}

/** A scenario's `verify` rejected a run's result. */
export class CheckFailed extends Data.TaggedError('CheckFailed')<{ readonly message: string }> {}

/** Keeps return values reachable so the JIT cannot drop the measured work. */
export let blackhole: unknown

interface Timer {
  /** Returns the start time. */
  readonly start: () => number
  readonly stop: () => number
  readonly heapDeltas: Array<number>
}

/** With memory, collects garbage before starting and records heap growth on stop. */
const makeTimer = (clock: Clock, memory: Memory | undefined): Timer => {
  let startedAt = 0
  let heapBefore = 0
  const heapDeltas: Array<number> = []
  return {
    heapDeltas,
    start: () => {
      memory?.gc?.()
      heapBefore = memory?.heapUsed?.() ?? 0
      startedAt = clock.nowNs()
      return startedAt
    },
    stop: () => {
      const elapsed = clock.nowNs() - startedAt
      if (memory?.heapUsed !== undefined) heapDeltas.push(memory.heapUsed() - heapBefore)
      return elapsed
    },
  }
}

type Batched = Extract<Operation, { readonly _tag: 'Sync' | 'Effect' | 'PerOp' }>
type SingleShot = Extract<Operation, { readonly _tag: 'Stream' | 'Scenario' }>

/** Returns the elapsed time of the timed part only; `PerOp` inputs are built before the timer starts. */
const makeBatch =
  (operation: Batched) =>
  (n: number, timer: Timer): Effect.Effect<number, unknown> => {
    switch (operation._tag) {
      case 'Sync': {
        const run = operation.run
        return Effect.sync(() => {
          timer.start()
          for (let i = 0; i < n; i++) blackhole = run()
          return timer.stop()
        })
      }
      case 'Effect': {
        const run = operation.run
        return Effect.gen(function* () {
          timer.start()
          for (let i = 0; i < n; i++) blackhole = yield* run
          return timer.stop()
        })
      }
      case 'PerOp': {
        const { before, run } = operation
        return Effect.gen(function* () {
          const inputs: Array<unknown> = []
          for (let i = 0; i < n; i++) inputs.push(yield* before)
          timer.start()
          for (const input of inputs) blackhole = yield* run(input)
          return timer.stop()
        })
      }
    }
  }

const emptyOperation = (operation: Batched): Batched => {
  switch (operation._tag) {
    case 'Sync':
      return { _tag: 'Sync', run: () => undefined }
    case 'Effect':
      return { _tag: 'Effect', run: Effect.void }
    case 'PerOp':
      return { _tag: 'PerOp', before: Effect.void, run: () => Effect.void }
  }
}

const measureBatched = Effect.fn('effectBench/measureBatched')(function* (operation: Batched, options: MeasureOptions) {
  const clock = yield* BenchClock
  const memory = yield* BenchMemory
  const targetSampleNs = options.targetSampleNs ?? 1_000_000
  const maxSamples = options.maxSamples ?? 10_000
  const units = operation._tag === 'Effect' ? (operation.units ?? 1) : 1
  const batch = makeBatch(operation)
  const empty = makeBatch(emptyOperation(operation))
  const plain = makeTimer(clock, undefined)
  const sampling = makeTimer(clock, options.memory ? memory : undefined)

  const warmupStartedAt = clock.nowNs()
  do yield* batch(1, plain)
  while (clock.nowNs() - warmupStartedAt < options.warmupNs)

  let batchSize = 1
  for (;;) {
    const elapsed = yield* batch(batchSize, plain)
    if (elapsed >= targetSampleNs || batchSize >= 2 ** 30) break
    batchSize = Math.min(batchSize * 100, Math.max(batchSize * 2, Math.ceil((batchSize * targetSampleNs) / elapsed)))
  }

  const overheads: Array<number> = []
  for (let i = 0; i < 5; i++) overheads.push(yield* empty(batchSize, plain))
  const overheadNs = median(overheads)

  const operations = batchSize * units
  const samplesNs: Array<number> = []
  const startedAt = clock.nowNs()
  while (
    samplesNs.length < maxSamples &&
    (samplesNs.length < options.samples || clock.nowNs() - startedAt < options.minTimeNs)
  ) {
    const elapsed = yield* batch(batchSize, sampling)
    samplesNs.push(Math.max(0, elapsed - overheadNs) / operations)
  }

  return {
    samplesNs,
    batchSize,
    overheadNs: overheadNs / operations,
    heapDeltaBytes:
      sampling.heapDeltas.length === 0 ? null : median(sampling.heapDeltas.map(delta => delta / operations)),
    metrics: null,
  } satisfies Measurement
})

interface Run {
  readonly elapsedNs: number
  /** Work units in the run: stream items, or 1 for a scenario. */
  readonly units: number
  readonly metrics: Readonly<Record<string, number>>
}

const runOnce = (operation: SingleShot, clock: Clock, memory: Memory, timer: Timer): Effect.Effect<Run, unknown> => {
  if (operation._tag === 'Stream') {
    return Effect.gen(function* () {
      const stream = operation.stream()
      const rss = memory.rss
      let items = 0
      let chunks = 0
      let firstItemNs = Number.NaN
      let peakRss = rss?.() ?? 0
      const startedAt = timer.start()
      yield* Stream.runForEachArray(stream, chunk =>
        Effect.sync(() => {
          if (items === 0) firstItemNs = clock.nowNs() - startedAt
          items += chunk.length
          blackhole = chunk
          // Reading RSS is a syscall; sampling every 64th chunk keeps it out of the timing.
          if (rss !== undefined && (chunks++ & 63) === 0) peakRss = Math.max(peakRss, rss())
        })
      )
      const elapsedNs = timer.stop()
      const metrics: Record<string, number> = { firstItemNs: items === 0 ? elapsedNs : firstItemNs, items }
      if (rss !== undefined) metrics['peakRssBytes'] = Math.max(peakRss, rss())
      return { elapsedNs, units: Math.max(items, 1), metrics }
    })
  }
  return Effect.gen(function* () {
    const input = operation.before === undefined ? undefined : yield* operation.before
    const phases = new Map<string, number>()
    const recorder = { path: '', record: (path: string, ns: number) => phases.set(path, (phases.get(path) ?? 0) + ns) }
    timer.start()
    const value = yield* Effect.provideService(operation.run(input), BenchPhases, recorder)
    const elapsedNs = timer.stop()
    if (operation.verify !== undefined && !operation.verify(value)) {
      return yield* new CheckFailed({ message: `verify rejected the result: ${String(value)}` })
    }
    return {
      elapsedNs,
      units: 1,
      metrics: Object.fromEntries([...phases].map(([path, ns]) => [`phase:${path}Ns`, ns])),
    }
  })
}

/** Streams and scenarios run whole once per sample; they are too slow to batch. */
const measureRuns = Effect.fn('effectBench/measureRuns')(function* (operation: SingleShot, options: MeasureOptions) {
  const clock = yield* BenchClock
  const memory = yield* BenchMemory
  const maxSamples = options.maxSamples ?? 10_000
  const plain = makeTimer(clock, undefined)
  const sampling = makeTimer(clock, options.memory ? memory : undefined)

  const warmupStartedAt = clock.nowNs()
  do yield* runOnce(operation, clock, memory, plain)
  while (clock.nowNs() - warmupStartedAt < options.warmupNs)

  const samplesNs: Array<number> = []
  const metrics: Record<string, Array<number>> = {}
  const startedAt = clock.nowNs()
  while (
    samplesNs.length < maxSamples &&
    (samplesNs.length < options.samples || clock.nowNs() - startedAt < options.minTimeNs)
  ) {
    const run = yield* runOnce(operation, clock, memory, sampling)
    samplesNs.push(run.elapsedNs / run.units)
    for (const [key, value] of Object.entries(run.metrics)) (metrics[key] ??= []).push(value)
  }

  return {
    samplesNs,
    batchSize: 1,
    overheadNs: 0,
    heapDeltaBytes: sampling.heapDeltas.length === 0 ? null : median(sampling.heapDeltas),
    metrics: Object.fromEntries(Object.entries(metrics).map(([key, values]) => [key, median(values)])),
  } satisfies Measurement
})

export const measure = (operation: Operation, options: MeasureOptions): Effect.Effect<Measurement, unknown> =>
  operation._tag === 'Stream' || operation._tag === 'Scenario'
    ? measureRuns(operation, options)
    : measureBatched(operation, options)
