import type { Bench } from '@effect-bench/core'
import type { Layer } from 'effect'

export interface Config {
  /** Globs relative to the working directory. */
  readonly include?: ReadonlyArray<string>
  readonly exclude?: ReadonlyArray<string>
  readonly modes?: Readonly<Record<string, Bench.Options>>
  readonly noiseThreshold?: number
  readonly baselineDirectory?: string
  /** Replaces services from the Node layer, e.g. a different baseline store. */
  readonly layer?: Layer.Layer<never, unknown>
}

export const make = (config: Config): Config => config

export const defaultModes: Readonly<Record<string, Bench.Options>> = {
  quick: { samples: 10, minTime: '100 millis', warmup: '50 millis' },
  rigorous: { samples: 100, minTime: '2 seconds', warmup: '1 second' },
}

export const defaults = {
  include: ['**/*.bench.ts'],
  exclude: ['**/node_modules/**', '**/dist/**'],
  noiseThreshold: 0.03,
  baselineDirectory: '.bench/baselines',
} as const
