import type { Bench } from '@avtheking/bench-core'
import type { Layer } from 'effect'

export interface Config {
  /** Globs relative to the working directory. */
  readonly include?: ReadonlyArray<string>
  readonly exclude?: ReadonlyArray<string>
  readonly modes?: Readonly<Record<string, Mode>>
  readonly noiseThreshold?: number
  readonly baselineDirectory?: string
  /** Replaces services from the Node layer, e.g. a different baseline store. */
  readonly layer?: Layer.Layer<never, unknown>
}

export interface Mode extends Bench.Options {
  /** Fresh processes per suite; 0 measures in the CLI process. */
  readonly forks?: number
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
