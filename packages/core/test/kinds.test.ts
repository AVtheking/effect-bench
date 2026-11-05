import { assert, describe, it } from '@effect/vitest'
import { Effect, Stream } from 'effect'
import { Bench, type BenchResult, Runner } from '../src/index.ts'

const quick = { samples: 5, minTime: 0, warmup: 0 } as const

const okResult = (results: ReadonlyArray<BenchResult>, id: string) => {
  const result = results.find(candidate => candidate.id === id)
  if (result?.status !== 'ok') throw new Error(`${id} did not succeed: ${JSON.stringify(result)}`)
  return result
}

describe('Bench.make with a spec', () => {
  it.effect('gives every operation a fresh, untimed input from before', () =>
    Effect.gen(function* () {
      const seen = new Set<object>()
      let reused = 0
      const suite = Bench.suite(
        'perOp',
        quick
      )(
        Bench.make('consume', {
          prepare: () => Effect.succeed(3),
          before: size => Effect.sync(() => Array.from({ length: size }, (_, i) => i)),
          run: rows =>
            Effect.sync(() => {
              if (seen.has(rows)) reused++
              seen.add(rows)
              return rows.length
            }),
          check: length => length === 3,
        })
      )
      const { results } = yield* Runner.run([suite])
      okResult(results, 'perOp/consume')
      assert.strictEqual(reused, 0)
      assert.isAbove(seen.size, 5)
    })
  )

  it.effect('passes the prepared value to run when there is no before', () =>
    Effect.gen(function* () {
      const suite = Bench.suite(
        'prepared',
        quick
      )(
        Bench.make('increment', {
          prepare: () => Effect.succeed(41),
          run: n => Effect.succeed(n + 1),
          check: value => value === 42,
        })
      )
      const { results } = yield* Runner.run([suite])
      okResult(results, 'prepared/increment')
    })
  )
})

describe('Bench.throughput', () => {
  it.effect('makes one bench per concurrency and reports per operation', () =>
    Effect.gen(function* () {
      let calls = 0
      const suite = Bench.suite(
        'queue',
        quick
      )(
        Bench.throughput('offer', {
          ops: 100,
          concurrency: [1, 4],
          run: index =>
            Effect.sync(() => {
              calls++
              return index
            }),
          check: value => value === 0,
        })
      )
      assert.deepStrictEqual(
        Runner.list([suite]).map(planned => planned.id),
        ['queue/offer[concurrency=1]', 'queue/offer[concurrency=4]']
      )
      const { results } = yield* Runner.run([suite])
      const serial = okResult(results, 'queue/offer[concurrency=1]')
      okResult(results, 'queue/offer[concurrency=4]')
      // check runs one operation, every other run performs all 100.
      assert.strictEqual((calls - 2) % 100, 0)
      assert.isAbove(serial.stats.opsPerSec ?? 0, 0)
    })
  )
})

describe('Bench.stream', () => {
  it.effect('reports per-item stats with time to first item', () =>
    Effect.gen(function* () {
      const suite = Bench.suite('streams', quick)(Bench.stream('range', { stream: () => Stream.range(1, 1000) }))
      const { results } = yield* Runner.run([suite])
      const range = okResult(results, 'streams/range')
      assert.strictEqual(range.metrics?.['items'], 1000)
      assert.isAtLeast(range.metrics?.['firstItemNs'] ?? -1, 0)
      assert.isAbove(range.stats.opsPerSec ?? 0, 0)
    })
  )
})

describe('Bench.scenario', () => {
  const spin = (ms: number) =>
    Effect.sync(() => {
      const until = performance.now() + ms
      while (performance.now() < until);
    })

  it.effect('records nested phases and gives each run a fresh input', () =>
    Effect.gen(function* () {
      let befores = 0
      let runs = 0
      const suite = Bench.suite(
        'flows',
        quick
      )(
        Bench.scenario('checkout', {
          before: () => Effect.sync(() => ++befores),
          run: ticket =>
            Effect.gen(function* () {
              runs++
              yield* Bench.phase('pay', Effect.andThen(spin(1), Bench.phase('charge', spin(1))))
              return ticket
            }),
          verify: ticket => ticket > 0,
        })
      )
      const { results } = yield* Runner.run([suite])
      const checkout = okResult(results, 'flows/checkout')
      const pay = checkout.metrics?.['phase:payNs'] ?? 0
      const charge = checkout.metrics?.['phase:pay/chargeNs'] ?? 0
      assert.isAbove(charge, 0)
      assert.isAbove(pay, charge)
      assert.strictEqual(befores, runs)
      assert.strictEqual(checkout.stats.samples + checkout.stats.outliers, 5)
    })
  )

  it.effect('fails in the check phase when verify rejects a run', () =>
    Effect.gen(function* () {
      const suite = Bench.suite(
        'flows',
        quick
      )(Bench.scenario('broken', { run: () => Effect.succeed(0), verify: value => value > 0 }))
      const { results } = yield* Runner.run([suite])
      assert.strictEqual(results[0]?.status === 'failed' && results[0].phase, 'check')
    })
  )

  it.effect('runs phases as plain effects outside a scenario', () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* Bench.phase('alone', Effect.succeed(1)), 1)
    })
  )
})
