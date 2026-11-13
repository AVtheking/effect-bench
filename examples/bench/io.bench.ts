import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Bench, HttpBench, SqlBench } from '@effect-bench/core'
import { PgliteClient } from '@effect/sql-pglite'
import { Effect, Layer } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http'
import { SqlClient } from 'effect/sql'

// In a real project the layer would point at a test database, e.g. one started with testcontainers.
const Database = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`create table events (id serial primary key, name text not null)`
    yield* sql`insert into events (name) select 'seed' from generate_series(1, 1000)`
  })
).pipe(Layer.provideMerge(PgliteClient.layer()))

const events = Bench.suite('events', { layer: Database })(
  SqlBench.make('insert', {
    run: () => Effect.flatMap(SqlClient.SqlClient, sql => sql`insert into events (name) values ('signup')`),
  }),
  SqlBench.make('countByName', {
    run: () =>
      Effect.flatMap(SqlClient.SqlClient, sql => sql`select name, count(*) from events group by name`),
  })
)

// A stand-in for the API under test, started once per process.
const Api = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.callback<ReturnType<typeof createServer>>(resume => {
        const http = createServer((_, response) => response.end('{"items":[]}'))
        http.listen(0, '127.0.0.1', () => resume(Effect.succeed(http)))
      }),
      http => Effect.sync(() => http.close())
    )
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return HttpClient.mapRequest(yield* HttpClient.HttpClient, HttpClientRequest.prependUrl(url))
  })
).pipe(Layer.provide(FetchHttpClient.layer))

const api = Bench.suite('api', { layer: Api })(
  HttpBench.load('listItems', {
    request: HttpClientRequest.get('/items'),
    rps: [100, 500],
    duration: '2 seconds',
    budget: { p99: '50 millis', errorRate: 0.001 },
  })
)

export default [events, api]
