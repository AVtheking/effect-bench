import type { Stats as StatsType } from './BenchResult.ts'

export const quantile = (sorted: ReadonlyArray<number>, q: number): number => {
  if (sorted.length === 0) return Number.NaN
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

export const median = (values: ReadonlyArray<number>): number =>
  quantile(
    [...values].sort((a, b) => a - b),
    0.5
  )

/** Drops Tukey outliers (outside 1.5 × IQR) before summarising. */
export const compute = (samplesNs: ReadonlyArray<number>): StatsType => {
  const sorted = [...samplesNs].sort((a, b) => a - b)
  const q1 = quantile(sorted, 0.25)
  const q3 = quantile(sorted, 0.75)
  const fence = 1.5 * (q3 - q1)
  const kept = sorted.filter(value => value >= q1 - fence && value <= q3 + fence)
  const n = kept.length
  const mean = kept.reduce((sum, value) => sum + value, 0) / n
  const variance = n > 1 ? kept.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1) : 0
  const medianNs = quantile(kept, 0.5)
  return {
    samples: n,
    outliers: sorted.length - n,
    meanNs: mean,
    medianNs,
    p75Ns: quantile(kept, 0.75),
    p99Ns: quantile(kept, 0.99),
    minNs: kept[0] ?? Number.NaN,
    maxNs: kept[n - 1] ?? Number.NaN,
    madNs: median(kept.map(value => Math.abs(value - medianNs))),
    rme: mean === 0 ? 0 : ((1.96 * Math.sqrt(variance)) / Math.sqrt(n) / mean) * 100,
    opsPerSec: medianNs > 0 ? 1e9 / medianNs : null,
  }
}

const units = [
  [1e9, 's'],
  [1e6, 'ms'],
  [1e3, 'µs'],
] as const

export const formatNs = (ns: number): string => {
  for (const [scale, unit] of units) if (Math.abs(ns) >= scale) return `${(ns / scale).toPrecision(3)} ${unit}`
  return `${ns.toPrecision(3)} ns`
}

export const formatBytes = (bytes: number): string => {
  const units = ['B', 'KiB', 'MiB', 'GiB'] as const
  let value = Math.abs(bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${bytes < 0 ? '-' : ''}${unit === 0 ? value.toFixed(0) : value.toPrecision(3)} ${units[unit]}`
}
