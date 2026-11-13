import { Data, Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import type { SqlError } from 'effect/sql/SqlError'
import * as Bench from './Bench.ts'

class Rollback extends Data.TaggedError('effectBench/Rollback')<{ readonly value: unknown }> {}

/** Runs `effect` in a transaction that is always rolled back and returns its value. */
export const rolledBack = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | SqlError, R | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.flatMap(effect, value => Effect.fail(new Rollback({ value })))).pipe(
      Effect.catchIf(
        (error): error is Rollback => error instanceof Rollback,
        ({ value }) => Effect.succeed(value as A)
      )
    )
  })

export interface Spec<Ctx, I, B, A, E, R> extends Omit<Bench.Spec<Ctx, I, B, A, E, R>, 'overhead'> {
  /**
   * Runs every operation in a transaction that is rolled back, so each one sees the same data (default true).
   * An empty rolled-back transaction is timed and subtracted, leaving the cost of `run` itself; commit cost is not measured.
   */
  readonly rollback?: boolean
}

/** A `Bench.make` for queries against the `SqlClient` in the suite layer. */
export const make = <Ctx = unknown, I = undefined, B = I, A = unknown, E = never, R = never>(
  name: string,
  { rollback = true, run, ...spec }: Spec<Ctx, I, B, A, E, R>
): Bench.Bench<Ctx, R | SqlClient.SqlClient> =>
  Bench.make<Ctx, I, B, A, E | SqlError, R | SqlClient.SqlClient>(
    name,
    rollback
      ? { ...spec, run: (input, ctx) => rolledBack(run(input, ctx)), overhead: () => rolledBack(Effect.void) }
      : { ...spec, run }
  )
