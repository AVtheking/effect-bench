import { Console, Effect, Layer, Option } from 'effect'
import { Argument, Command, Flag } from 'effect/cli'
import { type RawResult, Reporter, Runner } from '../index.ts'
import { NodeBench } from '../node/index.ts'
import { type Config, defaultModes, defaults } from './Config.ts'
import { discover, loadConfig } from './Discover.ts'
import { measureInChild, recordPrefix } from './Fork.ts'

const filter = Argument.String('filter').pipe(
  Argument.withDescription('Only benches whose id contains this text, or that carry this tag'),
  Argument.optional
)
const json = Flag.Boolean('json').pipe(
  Flag.withDescription('Print one JSON record per line on stdout'),
  Flag.withDefault(false)
)
const save = Flag.String('save').pipe(Flag.withDescription('Save results as a named baseline'), Flag.optional)
const compare = Flag.String('compare').pipe(Flag.withDescription('Compare against a saved baseline'), Flag.optional)
const mode = Flag.String('mode').pipe(
  Flag.withDescription('Sampling preset from the config, e.g. quick or rigorous'),
  Flag.optional
)
const quick = Flag.Boolean('quick').pipe(Flag.withDescription('Same as --mode quick'), Flag.withDefault(false))
const rigorous = Flag.Boolean('rigorous').pipe(Flag.withDescription('Same as --mode rigorous'), Flag.withDefault(false))
const forks = Flag.Int('forks').pipe(
  Flag.withDescription('Fresh processes per suite (default 3); 0 measures in this process'),
  Flag.optional
)
const threshold = Flag.Finite('threshold').pipe(
  Flag.withDescription('Relative change treated as noise (default 0.03)'),
  Flag.optional
)

const load = Effect.gen(function* () {
  const cwd = process.cwd()
  const config = yield* loadConfig(cwd)
  return { config, suites: yield* discover(cwd, config) }
})

const platformLayer = (config: Config) => {
  const node = NodeBench.layer({ baselineDirectory: config.baselineDirectory ?? defaults.baselineDirectory })
  return config.layer === undefined ? node : Layer.merge(node, config.layer)
}

const resolveMode = (config: Config, name: string | undefined) =>
  Effect.gen(function* () {
    const modes = { ...defaultModes, ...config.modes }
    if (name === undefined) return undefined
    const mode = modes[name]
    if (mode === undefined) {
      return yield* Effect.fail(`Unknown mode "${name}". Known modes: ${Object.keys(modes).join(', ')}`)
    }
    return mode
  })

const runBenches = (options: {
  readonly filter: Option.Option<string>
  readonly json: boolean
  readonly save: Option.Option<string>
  readonly compare: Option.Option<string>
  readonly mode: Option.Option<string>
  readonly quick: boolean
  readonly rigorous: boolean
  readonly forks: Option.Option<number>
  readonly threshold: Option.Option<number>
}) =>
  Effect.gen(function* () {
    const { config, suites } = yield* load
    const modeName = options.quick ? 'quick' : options.rigorous ? 'rigorous' : Option.getOrUndefined(options.mode)
    const mode = yield* resolveMode(config, modeName)
    const filter = Option.getOrUndefined(options.filter)
    const forkCount = Option.getOrElse(options.forks, () => mode?.forks ?? defaults.forks)

    const plan = Runner.plan(suites, { filter, mode })
    const forksRaw: Array<ReadonlyArray<RawResult>> = []
    if (forkCount === 0) {
      forksRaw.push(yield* Runner.measureSuites(suites, { filter, mode }).pipe(Effect.provide(platformLayer(config))))
    }
    // Fork-major order spreads slow drift (thermal, background load) across every suite instead of one.
    for (let fork = 1; fork <= forkCount; fork++) {
      const raws: Array<RawResult> = []
      for (const { suite, benches } of plan) {
        yield* Console.error(`fork ${fork}/${forkCount}  ${suite.name}`)
        raws.push(
          ...(yield* measureInChild(
            benches.map(({ planned }) => planned),
            { suite: suite.name, filter, mode: modeName }
          ))
        )
      }
      forksRaw.push(raws)
    }

    const { summary } = yield* Runner.finish(forksRaw, {
      save: Option.getOrUndefined(options.save),
      compare: Option.getOrUndefined(options.compare),
      noiseThreshold: Option.getOrElse(options.threshold, () => config.noiseThreshold ?? defaults.noiseThreshold),
    }).pipe(Effect.provide(Layer.merge(platformLayer(config), options.json ? Reporter.json : Reporter.table)))
    process.exitCode = summary.exitCode
  })

const measureCommand = Command.make('measure', { filter, mode, suite: Flag.String('suite') }, options =>
  Effect.gen(function* () {
    const { config, suites } = yield* load
    const mode = yield* resolveMode(config, Option.getOrUndefined(options.mode))
    const raws = yield* Runner.measureSuites(
      suites.filter(suite => suite.name === options.suite),
      { filter: Option.getOrUndefined(options.filter), mode }
    ).pipe(Effect.provide(platformLayer(config)))
    for (const raw of raws) yield* Console.log(`${recordPrefix}${JSON.stringify(raw)}`)
  })
).pipe(Command.withDescription('Internal: measure one suite in this process and print raw records'))

const runConfig = { filter, json, save, compare, mode, quick, rigorous, forks, threshold }

const run = Command.make('run', runConfig, runBenches).pipe(
  Command.withDescription('Run benches, optionally saving or comparing a baseline')
)

const check = Command.make(
  'check',
  { ...runConfig, compare: Flag.String('compare').pipe(Flag.withDescription('Baseline to compare against')) },
  options => runBenches({ ...options, compare: Option.some(options.compare) })
).pipe(Command.withDescription('Run benches against a baseline; exit 1 on a regression or blown budget'))

const list = Command.make('list', { filter, json }, options =>
  Effect.gen(function* () {
    const { suites } = yield* load
    const planned = Runner.list(suites, Option.getOrUndefined(options.filter))
    for (const bench of planned) yield* Console.log(options.json ? JSON.stringify(bench) : bench.id)
  })
).pipe(Command.withDescription('List bench ids without running anything'))

export const command = Command.make('effect-bench').pipe(
  Command.withDescription('Benchmarks for Effect code'),
  Command.withSubcommands([run, check, list, measureCommand])
)

export const main = Command.run(command, { version: '0.0.0' })
