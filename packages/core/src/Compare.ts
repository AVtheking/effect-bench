import type { Verdict } from './BenchResult.ts'
import { median } from './Stats.ts'

export interface CompareOptions {
  /** Changes smaller than this fraction count as noise. */
  readonly noiseThreshold: number
  readonly resamples?: number
  readonly seed?: number
}

export interface Change {
  readonly change: number
  readonly ci: readonly [number, number]
  readonly verdict: Verdict
}

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export const verdictOf = ([low, high]: readonly [number, number], noiseThreshold: number): Verdict =>
  high < -noiseThreshold
    ? 'faster'
    : low > noiseThreshold
      ? 'slower'
      : low >= -noiseThreshold && high <= noiseThreshold
        ? 'same'
        : 'inconclusive'

/** Bootstrap confidence interval (95%) for the relative change of the median. */
export const compare = (
  current: ReadonlyArray<number>,
  baseline: ReadonlyArray<number>,
  { noiseThreshold, resamples = 2000, seed = 0x5eed }: CompareOptions
): Change => {
  const change = median(current) / median(baseline) - 1
  if (current.length < 2 || baseline.length < 2) return { change, ci: [change, change], verdict: 'inconclusive' }

  const random = mulberry32(seed)
  const resample = (values: ReadonlyArray<number>) =>
    median(Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]!))
  const ratios = Array.from({ length: resamples }, () => resample(current) / resample(baseline) - 1).sort(
    (a, b) => a - b
  )
  const ci: readonly [number, number] = [
    ratios[Math.floor(resamples * 0.025)]!,
    ratios[Math.min(resamples - 1, Math.ceil(resamples * 0.975))]!,
  ]
  return { change, ci, verdict: verdictOf(ci, noiseThreshold) }
}
