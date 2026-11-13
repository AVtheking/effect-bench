import type { Bench } from '@effect-bench/core'
import type { Layer } from 'effect'

export interface Config {
  /** Globs relative to the working directory. */
  readonly include?: ReadonlyArray<string>
  readonly exclude?: ReadonlyArray<string>
  readonly modes?: Readonly<Record<string, Mode>>
  /** Resource limits to run forks under with `--profile`; each fork runs in a Docker container. */
  readonly profiles?: Readonly<Record<string, Profile>>
  readonly noiseThreshold?: number
  readonly baselineDirectory?: string
  /** Replaces services from the Node layer, e.g. a different baseline store. */
  readonly layer?: Layer.Layer<never, unknown>
}

export interface Mode extends Bench.Options {
  /** Fresh processes per suite; 0 measures in the CLI process. */
  readonly forks?: number
}

export interface Profile {
  /** CPU time the container may use, e.g. 1.5 (`docker --cpus`). */
  readonly cpus?: number
  /** Memory limit with no swap (`docker --memory`). */
  readonly memory?: Bench.Size
  /** CPUs the container is pinned to, e.g. `'0-1'` (`docker --cpuset-cpus`). */
  readonly cpuset?: string
  /** Defaults to the official Node image for the version running the CLI. */
  readonly image?: string
  /** Extra `docker run` arguments, e.g. `['-e', 'DATABASE_URL', '--network', 'host']`. */
  readonly dockerArgs?: ReadonlyArray<string>
}

export const make = (config: Config): Config => config

export const defaultModes: Readonly<Record<string, Mode>> = {
  quick: { samples: 10, minTime: '100 millis', warmup: '50 millis', forks: 3 },
  rigorous: { samples: 100, minTime: '2 seconds', warmup: '1 second', forks: 6 },
}

export const defaults = {
  include: ['**/*.bench.ts'],
  exclude: ['**/node_modules/**', '**/dist/**'],
  noiseThreshold: 0.03,
  forks: 3,
  baselineDirectory: '.bench/baselines',
} as const
