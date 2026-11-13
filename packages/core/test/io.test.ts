import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PgliteClient } from '@effect/sql-pglite'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http'
import { SqlClient } from 'effect/sql'
import { Bench, type BenchResult, HttpBench, Runner, SqlBench } from '../src/index.ts'

const quick = { samples: 5, minTime: 0, warmup: 0 } as const

const okResult = (results: ReadonlyArray<BenchResult>, id: string) => {
  const result = results.find(candidate => candidate.id === id)
  if (result?.status !== 'ok') throw new Error(`${id} did not succeed: ${JSON.stringify(result)}`)
  return result
}

const countRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ readonly count: number }>`select count(*)::int as count from events`
  return row!.count
})

describe('SqlBench', () => {
  it.effect('rolls every operation back, and commits when rollback is off', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`create table events (id serial primary key, name text not null)`
      const insert = sql`insert into events (name) values ('signup') returning id`
      const suite = Bench.suite('events', { ...quick, layer: Layer.succeed(SqlClient.SqlClient, sql) })(
        SqlBench.make('rolledBack', { run: () => insert, check: rows => rows.length === 1 }),
        SqlBench.make('committed', { rollback: false, run: () => insert })
      )

      const { results } = yield* Runner.run([suite], { filter: 'rolledBack' })
      const rolledBack = okResult(results, 'events/rolledBack')
      assert.strictEqual(yield* countRows, 0)
      // The empty transaction's cost is measured, so it can be subtracted.
      assert.isAbove(rolledBack.overheadNs, 0)

      yield* Runner.run([suite], { filter: 'committed' })
      assert.isAbove(yield* countRows, 0)
    }).pipe(Effect.provide(PgliteClient.layer()))
  )
})

const server = Effect.acquireRelease(
  Effect.callback<{ readonly url: string; readonly close: () => void }>(resume => {
    const http = createServer((request, response) => {
      response.statusCode = request.url === '/fail' ? 500 : 200
      response.end('{"ok":true}')
    })
    http.listen(0, '127.0.0.1', () =>
      resume(
        Effect.succeed({
          url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
          close: () => http.close(),
        })
      )
    )
  }),
  ({ close }) => Effect.sync(close)
)

describe('HttpBench.load', () => {
  it.live('sends at a constant rate and reports every latency with the error rate', () =>
    Effect.gen(function* () {
      const { url } = yield* server
      const client = Layer.effect(
        HttpClient.HttpClient,
        Effect.map(HttpClient.HttpClient, client => HttpClient.mapRequest(client, HttpClientRequest.prependUrl(url)))
      ).pipe(Layer.provide(FetchHttpClient.layer))
      const suite = Bench.suite('api', { layer: client, warmup: 0 })(
        HttpBench.load('ok', {
          request: HttpClientRequest.get('/ok'),
          rps: [100],
          duration: '300 millis',
          check: response => response.status === 200,
        }),
        HttpBench.load('fail', {
          request: HttpClientRequest.get('/fail'),
          rps: 100,
          duration: '300 millis',
          budget: { errorRate: 0.01 },
        })
      )
      const { results } = yield* Runner.run([suite])

      const ok = okResult(results, 'api/ok[rps=100]')
      assert.strictEqual(ok.metrics?.['requests'], 30)
      assert.strictEqual(ok.metrics?.['errorRate'], 0)
      // Load latencies keep their tail: every request is a sample.
      assert.strictEqual(ok.stats.samples + ok.stats.outliers, 30)
      assert.strictEqual(ok.stats.outliers, 0)

      const fail = okResult(results, 'api/fail[rps=100]')
      assert.strictEqual(fail.metrics?.['errorRate'], 1)
      assert.strictEqual(fail.budget?.status, 'exceeded')
    }).pipe(Effect.scoped)
  )
})
