import { assert, describe, it } from '@effect/vitest'
import { Context, Effect, Layer, Result } from 'effect'
import { Bench, BenchReporter, Compare, Runner, Stats } from '../src/index.ts'

const quick = { samples: 5, minTime: 0, warmup: 0 } as const

class Multiplier extends Context.Service<Multiplier, { readonly factor: number }>()('test/Multiplier') {}

describe('Stats', () => {
  it('summarises samples and drops outliers', () => {
    const stats = Stats.compute([10, 11, 12, 13, 14, 1000])
    assert.strictEqual(stats.outliers, 1)
    assert.strictEqual(stats.medianNs, 12)
    assert.strictEqual(stats.opsPerSec, 1e9 / 12)
    assert.isNull(Stats.compute([0, 0, 0]).opsPerSec)
  })

  it('formats nanoseconds', () => {
    assert.strictEqual(Stats.formatNs(1_500), '1.50 µs')
    assert.strictEqual(Stats.formatNs(2_340_000), '2.34 ms')
  })
})

describe('Compare', () => {
  const base = Array.from({ length: 50 }, (_, i) => 100 + (i % 5))

  it('calls identical distributions the same', () => {
    assert.strictEqual(Compare.compare(base, base, { noiseThreshold: 0.03 }).verdict, 'same')
  })

  it('detects a slowdown', () => {
    const slower = base.map(value => value * 1.2)
    const change = Compare.compare(slower, base, { noiseThreshold: 0.03 })
    assert.strictEqual(change.verdict, 'slower')
    assert.closeTo(change.change, 0.2, 0.01)
  })

  it('detects a speedup', () => {
    const faster = base.map(value => value * 0.8)
    assert.strictEqual(Compare.compare(faster, base, { noiseThreshold: 0.03 }).verdict, 'faster')
  })
})

const suite = Bench.suite('arith', {
  ...quick,
  layer: Layer.succeed(Multiplier, { factor: 3 }),
  setup: Effect.succeed({ base: 7 }),
})(
  Bench.make(
    'effect',
    ctx =>
      Effect.gen(function* () {
        const { factor } = yield* Multiplier
        return ctx.base * factor
      }),
    { check: value => value === 21 }
  ),
  Bench.sync('sync', ctx => ctx.base * 2),
  Bench.params(
    'sum',
    { size: [10, 100] },
    {
      prepare: ({ size }) => Effect.succeed(Array.from({ length: size }, (_, i) => i)),
      sync: input => input.reduce((a, b) => a + b, 0),
    }
  ),
  Bench.group('loops', { baseline: 'for' })(
    Bench.sync('for', () => {
      let total = 0
      for (let i = 0; i < 100; i++) total += i
      return total
    }),
    Bench.sync('reduce', () => Array.from({ length: 100 }, (_, i) => i).reduce((a, b) => a + b, 0))
  ),
  Bench.sync('rejected', () => Result.fail('nope'), { check: Result.isSuccess }),
  Bench.sync('slow budget', () => 1, { budget: { p50: 0 } })
)

describe('Runner', () => {
  it('lists stable ids', () => {
    assert.deepStrictEqual(
      Runner.list([suite]).map(planned => planned.id),
      [
        'arith/effect',
        'arith/sync',
        'arith/sum[size=10]',
        'arith/sum[size=100]',
        'arith/loops/for',
        'arith/loops/reduce',
        'arith/rejected',
        'arith/slow budget',
      ]
    )
  })

  it.effect('runs, saves and compares a baseline', () =>
    Effect.gen(function* () {
      const reported: Array<string> = []
      const reporter = Layer.succeed(BenchReporter, {
        onResult: result => Effect.sync(() => void reported.push(result.id)),
        onEnd: () => Effect.void,
      })

      const first = yield* Runner.run([suite], { save: 'before' }).pipe(Effect.provide(reporter))
      const byId = new Map(first.results.map(result => [result.id, result]))

      assert.strictEqual(reported.length, 8)
      assert.strictEqual(byId.get('arith/effect')?.status, 'ok')
      const rejected = byId.get('arith/rejected')
      assert.strictEqual(rejected?.status === 'failed' && rejected.phase, 'check')
      const reduce = byId.get('arith/loops/reduce')
      assert.strictEqual(reduce?.status === 'ok' && reduce.relative?.baselineId, 'arith/loops/for')
      const budget = byId.get('arith/slow budget')
      assert.strictEqual(budget?.status === 'ok' && budget.budget?.status, 'exceeded')
      assert.deepStrictEqual(first.summary, {
        total: 8,
        failed: 1,
        regressions: 0,
        budgetsExceeded: 1,
        stale: 0,
        exitCode: 2,
      })

      const second = yield* Runner.run([suite], { compare: 'before', filter: 'arith/sync' })
      const [sync] = second.results
      assert.strictEqual(second.results.length, 1)
      assert.strictEqual(sync?.status === 'ok' && sync.comparison?.baseline, 'before')
    })
  )

  it.effect('fails when the baseline is missing', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Runner.run([suite], { compare: 'missing' }))
      assert.strictEqual(error._tag, 'BaselineError')
    })
  )

  it.effect('reports setup failures for every bench', () =>
    Effect.gen(function* () {
      const broken = Bench.suite('broken', { setup: Effect.fail('boom') })(Bench.sync('a', () => 1))
      const { results } = yield* Runner.run([broken])
      assert.strictEqual(results[0]?.status === 'failed' && results[0].phase, 'setup')
    })
  )
})

describe('types', () => {
  it('rejects benches that need services the suite does not provide', () => {
    Bench.suite('missing')(
      // @ts-expect-error Multiplier is not provided by this suite
      Bench.make(
        'needs multiplier',
        Effect.gen(function* () {
          return (yield* Multiplier).factor
        })
      )
    )
  })
})
