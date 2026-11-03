import { Effect } from 'effect'
import type { Operation } from './Bench.ts'
import { BenchClock, BenchMemory } from './Services.ts'
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
}

/** Keeps return values reachable so the JIT cannot drop the measured work. */
export let blackhole: unknown

const makeBatch =
  (operation: Operation) =>
  (n: number): Effect.Effect<void, unknown> => {
    if (operation._tag === 'Sync') {
      const run = operation.run
      return Effect.sync(() => {
        for (let i = 0; i < n; i++) blackhole = run()
      })
    }
    const run = operation.run
    return Effect.gen(function* () {
      for (let i = 0; i < n; i++) blackhole = yield* run
    })
  }

const emptyOperation = (operation: Operation): Operation =>
  operation._tag === 'Sync' ? { _tag: 'Sync', run: () => undefined } : { _tag: 'Effect', run: Effect.void }

export const measure = Effect.fn('effectBench/measure')(function* (operation: Operation, options: MeasureOptions) {
  const clock = yield* BenchClock
  const memory = yield* BenchMemory
  const targetSampleNs = options.targetSampleNs ?? 1_000_000
  const maxSamples = options.maxSamples ?? 10_000
  const batch = makeBatch(operation)
  const empty = makeBatch(emptyOperation(operation))

  const time = (run: (n: number) => Effect.Effect<void, unknown>, n: number) =>
    Effect.suspend(() => {
      const startedAt = clock.nowNs()
      return Effect.map(run(n), () => clock.nowNs() - startedAt)
    })

  const warmupStartedAt = clock.nowNs()
  do yield* batch(1)
  while (clock.nowNs() - warmupStartedAt < options.warmupNs)

  let batchSize = 1
  for (;;) {
    const elapsed = yield* time(batch, batchSize)
    if (elapsed >= targetSampleNs || batchSize >= 2 ** 30) break
    batchSize = Math.min(batchSize * 100, Math.max(batchSize * 2, Math.ceil((batchSize * targetSampleNs) / elapsed)))
  }

  const overheads: Array<number> = []
  for (let i = 0; i < 5; i++) overheads.push(yield* time(empty, batchSize))
  const overheadNs = median(overheads)

  const samplesNs: Array<number> = []
  const heapDeltas: Array<number> = []
  const gc = options.memory ? memory.gc : undefined
  const heapUsed = options.memory ? memory.heapUsed : undefined
  const startedAt = clock.nowNs()
  while (
    samplesNs.length < maxSamples &&
    (samplesNs.length < options.samples || clock.nowNs() - startedAt < options.minTimeNs)
  ) {
    gc?.()
    const heapBefore = heapUsed?.()
    const elapsed = yield* time(batch, batchSize)
    if (heapBefore !== undefined) heapDeltas.push((heapUsed!() - heapBefore) / batchSize)
    samplesNs.push(Math.max(0, elapsed - overheadNs) / batchSize)
  }

  return {
    samplesNs,
    batchSize,
    overheadNs: overheadNs / batchSize,
    heapDeltaBytes: heapDeltas.length === 0 ? null : median(heapDeltas),
  } satisfies Measurement
})
