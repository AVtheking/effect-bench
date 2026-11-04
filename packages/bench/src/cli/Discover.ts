import { existsSync } from 'node:fs'
import { glob } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Data, Effect } from 'effect'
import type { Bench } from '../index.ts'
import { type Config, defaults } from './Config.ts'

export class DiscoveryError extends Data.TaggedError('DiscoveryError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const configFile = 'effect-bench.config.ts'

const importModule = (file: string) =>
  Effect.tryPromise({
    try: () => import(pathToFileURL(resolve(file)).href) as Promise<{ readonly default?: unknown }>,
    catch: cause => new DiscoveryError({ message: `Could not import ${file}.`, cause }),
  })

export const loadConfig = Effect.fn('effectBench/loadConfig')(function* (cwd: string) {
  const file = resolve(cwd, configFile)
  if (!existsSync(file)) return {} satisfies Config
  return ((yield* importModule(file)).default ?? {}) as Config
})

const isSuite = (value: unknown): value is Bench.Suite =>
  typeof value === 'object' && value !== null && '_tag' in value && value._tag === 'Suite'

export const discover = Effect.fn('effectBench/discover')(function* (cwd: string, config: Config) {
  const exclude = config.exclude ?? defaults.exclude
  const files = yield* Effect.tryPromise({
    try: async () => {
      const found: Array<string> = []
      for await (const file of glob([...(config.include ?? defaults.include)], { cwd, exclude: [...exclude] })) {
        found.push(file)
      }
      return found
    },
    catch: cause => new DiscoveryError({ message: 'Could not search for bench files.', cause }),
  })

  const suites: Array<Bench.Suite> = []
  for (const file of files.sort()) {
    const exported = (yield* importModule(resolve(cwd, file))).default
    const candidates = Array.isArray(exported) ? exported : [exported]
    if (!candidates.every(isSuite)) {
      return yield* new DiscoveryError({ message: `${file} must default-export a suite or an array of suites.` })
    }
    suites.push(...candidates)
  }
  return suites
})
