import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { RawResult, Runner } from '@effect-bench/core'
import { Console, Effect, Schema } from 'effect'

/** Marks result lines so stray console output from bench code is ignored. */
export const recordPrefix = '@@effect-bench '

// Published builds run from dist/*.js, the workspace from src/*.ts.
const bin = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './bin.ts' : './bin.js', import.meta.url))
const decodeRaw = Schema.decodeUnknownSync(Schema.fromJsonString(RawResult))

interface ChildOutput {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | string | null
}

const spawn = (args: ReadonlyArray<string>) =>
  Effect.callback<ChildOutput>(resume => {
    const execArgv = [...new Set([...process.execArgv, '--expose-gc'])]
    const child = execFile(
      process.execPath,
      [...execArgv, bin, ...args],
      { maxBuffer: 256 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) =>
        resume(Effect.succeed({ stdout, stderr, exitCode: error === null ? null : (error.code ?? null) }))
    )
    return Effect.sync(() => child.kill())
  })

/** Runs one suite in a fresh process and returns its raw records; a crash fails every planned bench. */
export const measureInChild = Effect.fn('effectBench/measureInChild')(function* (
  planned: ReadonlyArray<Runner.PlannedBench>,
  options: { readonly suite: string; readonly filter: string | undefined; readonly mode: string | undefined }
) {
  const output = yield* spawn([
    'measure',
    '--suite',
    options.suite,
    ...(options.mode === undefined ? [] : ['--mode', options.mode]),
    ...(options.filter === undefined ? [] : [options.filter]),
  ])
  const records = output.stdout
    .split('\n')
    .filter(line => line.startsWith(recordPrefix))
    .map(line => decodeRaw(line.slice(recordPrefix.length)))
  const missing = planned.filter(bench => !records.some(record => record.id === bench.id))
  if (missing.length > 0) {
    const stderr = output.stderr.trim().split('\n').slice(-20).join('\n')
    const exited =
      output.exitCode === null
        ? 'the child process produced no result'
        : `the child process exited with ${output.exitCode}`
    const reason = stderr === '' ? exited : `${exited}:\n${stderr}`
    if (output.exitCode !== null) yield* Console.error(reason)
    return [...records, ...missing.map(bench => Runner.failed(bench, 'run', reason))]
  }
  return records
})
