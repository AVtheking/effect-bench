import { Bench } from '@effect-bench/core'
import { Effect, Ref, Stream } from 'effect'

const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i, email: `user${i}@example.com` }))

export default Bench.suite('kinds')(
  Bench.make('sort', {
    // A fresh shuffled copy per operation, so sort never sees already sorted input.
    before: () => Effect.sync(() => rows.toSorted(() => Math.random() - 0.5)),
    run: input => Effect.sync(() => input.sort((a, b) => a.id - b.id)),
    budget: { heapDelta: '1 MiB' },
  }),

  Bench.throughput('counter', {
    ops: 1000,
    concurrency: [1, 16],
    prepare: () => Ref.make(0),
    run: (_, counter) => Ref.update(counter, n => n + 1),
  }),

  Bench.stream('emails', {
    stream: () =>
      Stream.fromIterable(rows).pipe(
        Stream.map(row => row.email.toUpperCase()),
        Stream.filter(email => email.endsWith('.COM'))
      ),
  }),

  Bench.scenario('import', {
    run: () =>
      Effect.gen(function* () {
        const parsed = yield* Bench.phase(
          'parse',
          Effect.sync(() => JSON.parse(JSON.stringify(rows)) as typeof rows)
        )
        return yield* Bench.phase(
          'index',
          Effect.sync(() => new Map(parsed.map(row => [row.email, row])))
        )
      }),
    verify: index => index.size === rows.length,
  })
)
