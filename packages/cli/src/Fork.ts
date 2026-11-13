import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bench, RawResult, Runner } from '@effect-bench/core'
import { Console, Effect, Schema } from 'effect'
import type { Profile } from './Config.ts'

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

const commonAncestor = (paths: ReadonlyArray<string>) => {
  const [first = [], ...rest] = paths.map(path => path.split(sep))
  const length = first.findIndex((part, index) => rest.some(parts => parts[index] !== part))
  return (length === -1 ? first : first.slice(0, length)).join(sep) || sep
}

/**
 * Runs the same Node and CLI inside a container. The project and the CLI are mounted at their host paths, so module
 * resolution works unchanged; native addons built for another OS will not load.
 */
const dockerCommand = (profile: Profile, node: ReadonlyArray<string>): readonly [string, ReadonlyArray<string>] => {
  const cwd = process.cwd()
  const root = commonAncestor([cwd, realpathSync(bin)])
  return [
    'docker',
    [
      'run',
      '--rm',
      ...(profile.cpus === undefined ? [] : ['--cpus', String(profile.cpus)]),
      ...(profile.memory === undefined
        ? []
        : ['--memory', `${Bench.toBytes(profile.memory)}b`, '--memory-swap', `${Bench.toBytes(profile.memory)}b`]),
      ...(profile.cpuset === undefined ? [] : ['--cpuset-cpus', profile.cpuset]),
      '--volume',
      `${root}:${root}:ro`,
      '--workdir',
      cwd,
      ...(profile.dockerArgs ?? []),
      profile.image ?? `node:${process.versions.node}-slim`,
      'node',
      ...node,
    ],
  ]
}

const spawn = (args: ReadonlyArray<string>, profile: Profile | undefined) =>
  Effect.callback<ChildOutput>(resume => {
    const node = [...new Set([...process.execArgv, '--expose-gc'])].concat(bin, args)
    const [command, commandArgs] = profile === undefined ? [process.execPath, node] : dockerCommand(profile, node)
    const child = execFile(
      command,
      commandArgs,
      { maxBuffer: 256 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) =>
        resume(Effect.succeed({ stdout, stderr, exitCode: error === null ? null : (error.code ?? null) }))
    )
    return Effect.sync(() => child.kill())
  })

/** Runs one suite in a fresh process and returns its raw records; a crash fails every planned bench. */
export const measureInChild = Effect.fn('effectBench/measureInChild')(function* (
  planned: ReadonlyArray<Runner.PlannedBench>,
  options: {
    readonly suite: string
    readonly filter: string | undefined
    readonly mode: string | undefined
    readonly profile: { readonly name: string; readonly settings: Profile } | undefined
  }
) {
  const output = yield* spawn(
    [
      'measure',
      '--suite',
      options.suite,
      ...(options.mode === undefined ? [] : ['--mode', options.mode]),
      ...(options.profile === undefined ? [] : ['--profile', options.profile.name]),
      ...(options.filter === undefined ? [] : [options.filter]),
    ],
    options.profile?.settings
  )
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
