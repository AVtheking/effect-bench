import { Schema } from 'effect'

export const schemaVersion = 1

export const Stats = Schema.Struct({
  samples: Schema.Number,
  outliers: Schema.Number,
  meanNs: Schema.Number,
  medianNs: Schema.Number,
  p75Ns: Schema.Number,
  p99Ns: Schema.Number,
  minNs: Schema.Number,
  maxNs: Schema.Number,
  madNs: Schema.Number,
  rme: Schema.Number,
  opsPerSec: Schema.Number,
})
export type Stats = typeof Stats.Type

export const Environment = Schema.Struct({
  runtime: Schema.String,
  runtimeVersion: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  cpu: Schema.String,
  cpus: Schema.Number,
  gitSha: Schema.NullOr(Schema.String),
  gitDirty: Schema.NullOr(Schema.Boolean),
})
export type Environment = typeof Environment.Type

export const Verdict = Schema.Literals(['faster', 'slower', 'same', 'inconclusive'])
export type Verdict = typeof Verdict.Type

export const Comparison = Schema.Struct({
  baseline: Schema.String,
  baselineMedianNs: Schema.Number,
  change: Schema.Number,
  ci: Schema.Tuple([Schema.Number, Schema.Number]),
  verdict: Verdict,
  /** The baseline was recorded on a different runtime or machine. */
  stale: Schema.Boolean,
})
export type Comparison = typeof Comparison.Type

export const BudgetCheck = Schema.Struct({
  status: Schema.Literals(['ok', 'exceeded']),
  violations: Schema.Array(Schema.String),
})
export type BudgetCheck = typeof BudgetCheck.Type

export const Relative = Schema.Struct({
  baselineId: Schema.String,
  ratio: Schema.Number,
})
export type Relative = typeof Relative.Type

const identity = {
  id: Schema.String,
  suite: Schema.String,
  name: Schema.String,
  group: Schema.NullOr(Schema.String),
  params: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  tags: Schema.Array(Schema.String),
}

export const OkResult = Schema.Struct({
  status: Schema.Literal('ok'),
  ...identity,
  stats: Stats,
  batchSize: Schema.Number,
  overheadNs: Schema.Number,
  heapDeltaBytes: Schema.NullOr(Schema.Number),
  budget: Schema.NullOr(BudgetCheck),
  comparison: Schema.NullOr(Comparison),
  relative: Schema.NullOr(Relative),
})
export type OkResult = typeof OkResult.Type

export const FailedResult = Schema.Struct({
  status: Schema.Literal('failed'),
  ...identity,
  phase: Schema.Literals(['setup', 'prepare', 'check', 'run']),
  message: Schema.String,
})
export type FailedResult = typeof FailedResult.Type

export const BenchResult = Schema.Union([OkResult, FailedResult])
export type BenchResult = typeof BenchResult.Type

export const Summary = Schema.Struct({
  total: Schema.Number,
  failed: Schema.Number,
  regressions: Schema.Number,
  budgetsExceeded: Schema.Number,
  stale: Schema.Number,
  exitCode: Schema.Number,
})
export type Summary = typeof Summary.Type

export const BaselineEntry = Schema.Struct({
  id: Schema.String,
  samplesNs: Schema.Array(Schema.Number),
  stats: Stats,
})
export type BaselineEntry = typeof BaselineEntry.Type

export const Baseline = Schema.Struct({
  schemaVersion: Schema.Number,
  name: Schema.String,
  createdAt: Schema.String,
  environment: Environment,
  entries: Schema.Array(BaselineEntry),
})
export type Baseline = typeof Baseline.Type
