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

const pick = <A>(values: ReadonlyArray<A>, random: () => number): A => values[Math.floor(random() * values.length)]!

const percentile95 = (sorted: ReadonlyArray<number>): readonly [number, number] => [
  sorted[Math.floor(sorted.length * 0.025)]!,
  sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.975))]!,
]

const bootstrap = (
  current: ReadonlyArray<number>,
  baseline: ReadonlyArray<number>,
  resamples: number,
  seed: number
): readonly [number, number] => {
  const random = mulberry32(seed)
  const resample = (values: ReadonlyArray<number>) => median(Array.from(values, () => pick(values, random)))
  return percentile95(
    Array.from({ length: resamples }, () => resample(current) / resample(baseline) - 1).sort((a, b) => a - b)
  )
}

const tTable: ReadonlyArray<readonly [df: number, t: number]> = [
  [1, 12.706],
  [2, 4.303],
  [3, 3.182],
  [4, 2.776],
  [5, 2.571],
  [6, 2.447],
  [7, 2.365],
  [8, 2.306],
  [9, 2.262],
  [10, 2.228],
  [12, 2.179],
  [15, 2.131],
  [20, 2.086],
  [30, 2.042],
  [60, 2.0],
]

/** Two-sided 97.5% quantile of Student's t, conservative between table rows. */
export const tQuantile = (df: number): number => tTable.findLast(([rowDf]) => rowDf <= df)?.[1] ?? 1.96

const variance = (values: ReadonlyArray<number>) => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
}

/**
 * Drift between processes (JIT state, CPU frequency) dwarfs noise within one run, so each fork's median is one
 * observation: a pooled t-interval on log medians. Only when both sides have a single fork does it fall back to a
 * bootstrap over samples, which sees within-run noise only.
 */
export const compare = (
  current: ReadonlyArray<ReadonlyArray<number>>,
  baseline: ReadonlyArray<ReadonlyArray<number>>,
  { noiseThreshold, resamples = 2000, seed = 0x5eed }: CompareOptions
): Change => {
  const change = median(current.flat()) / median(baseline.flat()) - 1
  const forkLogs = (forks: ReadonlyArray<ReadonlyArray<number>>) =>
    forks.filter(fork => fork.length > 0).map(fork => Math.log(median(fork)))
  const currentLogs = forkLogs(current)
  const baselineLogs = forkLogs(baseline)
  const df = Math.max(0, currentLogs.length - 1) + Math.max(0, baselineLogs.length - 1)

  if (currentLogs.length === 0 || baselineLogs.length === 0 || !Number.isFinite(change)) {
    return { change, ci: [change, change], verdict: 'inconclusive' }
  }
  if (df === 0) {
    const ci = bootstrap(current.flat(), baseline.flat(), resamples, seed)
    return { change, ci, verdict: verdictOf(ci, noiseThreshold) }
  }

  const pooled =
    ((currentLogs.length - 1) * (currentLogs.length > 1 ? variance(currentLogs) : 0) +
      (baselineLogs.length - 1) * (baselineLogs.length > 1 ? variance(baselineLogs) : 0)) /
    df
  const mean = (values: ReadonlyArray<number>) => values.reduce((sum, value) => sum + value, 0) / values.length
  const diff = mean(currentLogs) - mean(baselineLogs)
  const halfWidth = tQuantile(df) * Math.sqrt(pooled * (1 / currentLogs.length + 1 / baselineLogs.length))
  const ci: readonly [number, number] = [Math.exp(diff - halfWidth) - 1, Math.exp(diff + halfWidth) - 1]
  return { change, ci, verdict: verdictOf(ci, noiseThreshold) }
}
