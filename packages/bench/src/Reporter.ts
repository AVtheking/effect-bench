import { Console, Effect, Layer } from 'effect'
import { type BenchResult, schemaVersion } from './BenchResult.ts'
import { BenchReporter } from './Services.ts'
import { formatNs } from './Stats.ts'

const json = Layer.succeed(BenchReporter, {
  onResult: result => Console.log(JSON.stringify({ type: 'result', schemaVersion, ...result })),
  onEnd: summary => Console.log(JSON.stringify({ type: 'summary', schemaVersion, ...summary })),
})

const percent = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`

const row = (result: BenchResult): ReadonlyArray<string> => {
  if (result.status === 'failed') return [result.id, `failed (${result.phase})`, '', '', '', '', '']
  const { stats, comparison, relative, budget } = result
  return [
    result.id,
    formatNs(stats.medianNs),
    formatNs(stats.p99Ns),
    `±${stats.rme.toFixed(1)}%`,
    stats.opsPerSec?.toLocaleString('en-US', { maximumFractionDigits: 0 }) ?? '—',
    comparison === null
      ? relative === null || relative.ratio === 1
        ? ''
        : `${relative.ratio.toFixed(2)}x vs ${relative.baselineId.split('/').at(-1)}`
      : `${percent(comparison.change)} [${percent(comparison.ci[0])}, ${percent(comparison.ci[1])}] ${comparison.verdict}${comparison.stale ? ' (stale)' : ''}`,
    budget?.status === 'exceeded' ? `over budget: ${budget.violations.join(', ')}` : '',
  ]
}

const render = (rows: ReadonlyArray<ReadonlyArray<string>>) => {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(cells => cells[column]!.length)))
  return rows
    .map(cells =>
      cells
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join('  ')
        .trimEnd()
    )
    .join('\n')
}

const table = Layer.succeed(BenchReporter, {
  onResult: result => Console.error(`${result.status === 'ok' ? '✓' : '✗'} ${result.id}`),
  onEnd: (summary, results) =>
    Effect.gen(function* () {
      if (results.length === 0) return yield* Console.log('No benches matched.')
      yield* Console.log(render([['bench', 'median', 'p99', 'rme', 'ops/s', 'change', 'budget'], ...results.map(row)]))
      for (const result of results)
        if (result.status === 'failed') yield* Console.log(`\n${result.id}:\n${result.message}`)
      yield* Console.log(
        `\n${summary.total} benches, ${summary.failed} failed, ${summary.regressions} slower, ${summary.budgetsExceeded} over budget`
      )
    }),
})

export { json, table }
