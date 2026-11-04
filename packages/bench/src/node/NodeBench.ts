import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Option, Path, Schema } from 'effect'
import { Baseline, BaselineError, BaselineStore, BenchClock, BenchEnvironment, BenchMemory } from '../index.ts'

export const clock = Layer.sync(BenchClock, () => {
  // Offset from layer creation so the value stays well inside float precision.
  const origin = process.hrtime.bigint()
  return { nowNs: () => Number(process.hrtime.bigint() - origin) }
})

const exposeGc = (): (() => void) | undefined => {
  if (typeof globalThis.gc === 'function') return globalThis.gc
  try {
    setFlagsFromString('--expose-gc')
    return runInNewContext('gc') as () => void
  } catch {
    return undefined
  }
}

export const memory = Layer.sync(BenchMemory, () => ({
  gc: exposeGc(),
  heapUsed: () => process.memoryUsage().heapUsed,
}))

const git = (args: ReadonlyArray<string>): string | null => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

export const environment = Layer.succeed(BenchEnvironment, {
  fingerprint: Effect.sync(() => {
    const cpus = os.cpus()
    const status = git(['status', '--porcelain'])
    return {
      runtime: typeof process.versions['bun'] === 'string' ? 'bun' : 'node',
      runtimeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus[0]?.model.trim() ?? 'unknown',
      cpus: cpus.length,
      gitSha: git(['rev-parse', 'HEAD']),
      gitDirty: status === null ? null : status.length > 0,
    }
  }),
})

const BaselineJson = Schema.fromJsonString(Baseline)

export const baselineStore = (directory = '.bench/baselines') =>
  Layer.effect(
    BaselineStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const fileOf = (name: string) => path.join(directory, `${name}.json`)
      const failure = (name: string, message: string) => (cause: unknown) => new BaselineError({ name, message, cause })

      return {
        save: baseline =>
          Effect.gen(function* () {
            const json = yield* Schema.encodeEffect(BaselineJson)(baseline)
            yield* fs.makeDirectory(directory, { recursive: true })
            yield* fs.writeFileString(fileOf(baseline.name), json)
          }).pipe(Effect.mapError(failure(baseline.name, `Could not save baseline "${baseline.name}".`))),
        load: name =>
          Effect.gen(function* () {
            if (!(yield* fs.exists(fileOf(name)))) return Option.none()
            const json = yield* fs.readFileString(fileOf(name))
            return Option.some(yield* Schema.decodeUnknownEffect(BaselineJson)(json))
          }).pipe(Effect.mapError(failure(name, `Could not load baseline "${name}".`))),
      }
    })
  )

export const layer = (options: { readonly baselineDirectory?: string } = {}) =>
  Layer.mergeAll(clock, memory, environment, baselineStore(options.baselineDirectory)).pipe(
    Layer.provide(NodeServices.layer)
  )
