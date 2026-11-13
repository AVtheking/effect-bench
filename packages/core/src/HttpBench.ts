import type { Duration } from 'effect'
import { Effect } from 'effect'
import { HttpClient, type HttpClientError, type HttpClientRequest, type HttpClientResponse } from 'effect/http'
import * as Bench from './Bench.ts'

type Request<I, Ctx> =
  | HttpClientRequest.HttpClientRequest
  | ((index: number, input: I, ctx: Ctx) => HttpClientRequest.HttpClientRequest)

export interface LoadSpec<Ctx, I, R> extends Bench.Options {
  readonly request: Request<I, Ctx>
  /** Requests started per second. An array makes one bench per value. */
  readonly rps: number | ReadonlyArray<number>
  readonly duration: Duration.Input
  readonly prepare?: (ctx: Ctx) => Effect.Effect<I, unknown, R>
  /** Defaults to any status of 400 or above. */
  readonly isError?: (response: HttpClientResponse.HttpClientResponse) => boolean
  readonly check?: (response: HttpClientResponse.HttpClientResponse) => boolean
}

/**
 * Sends requests through the `HttpClient` in the suite layer at a constant rate and reports latency, including the
 * body download, with `errorRate` and `achievedRps` as metrics. Set the base URL on the client, e.g. with
 * `HttpClient.mapRequest(HttpClientRequest.prependUrl(url))`.
 */
export const load = <Ctx = unknown, I = undefined, R = never>(
  name: string,
  { request, isError, ...spec }: LoadSpec<Ctx, I, R>
): ReadonlyArray<Bench.Bench<Ctx, R | HttpClient.HttpClient>> =>
  Bench.load<Ctx, I, HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError, R | HttpClient.HttpClient>(
    name,
    {
      ...spec,
      send: (index, input: I, ctx: Ctx) =>
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient
          const response = yield* client.execute(typeof request === 'function' ? request(index, input, ctx) : request)
          // Reading the body lets the connection be reused and counts the download.
          yield* response.arrayBuffer
          return response
        }),
      isError: isError ?? (response => response.status >= 400),
    }
  )
