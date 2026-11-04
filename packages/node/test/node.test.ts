import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bench, BenchEnvironment, BenchMemory, Runner } from '@effect-bench/core'
import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { NodeBench } from '../src/index.ts'

const suite = Bench.suite('node', { samples: 5, minTime: 0, warmup: 0, memory: true })(
  Bench.sync('allocate', () => Array.from({ length: 1000 }, (_, i) => ({ i })))
)

describe('NodeBench', () => {
  it.effect('fingerprints the environment and exposes gc', () =>
    Effect.gen(function* () {
      const environment = yield* (yield* BenchEnvironment).fingerprint
      assert.strictEqual(environment.runtime, 'node')
      assert.isAbove(environment.cpus, 0)
      assert.isFunction((yield* BenchMemory).gc)
    }).pipe(Effect.provide(NodeBench.layer()))
  )

  it.effect('saves and compares baselines on disk', () =>
    Effect.gen(function* () {
      const first = yield* Runner.run([suite], { save: 'before' })
      const allocate = first.results[0]
      assert.isTrue(allocate?.status === 'ok' && (allocate.heapDeltaBytes ?? 0) > 0)

      const second = yield* Runner.run([suite], { compare: 'before' })
      const compared = second.results[0]
      assert.strictEqual(compared?.status === 'ok' && compared.comparison?.stale, false)
    }).pipe(Effect.provide(NodeBench.layer({ baselineDirectory: mkdtempSync(join(tmpdir(), 'effect-bench-')) })))
  )
})
