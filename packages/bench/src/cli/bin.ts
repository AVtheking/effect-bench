#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Exit } from 'effect'
import { main } from './Cli.ts'

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)), {
  // Failures (bad flags, missing baseline, import errors) exit 2; otherwise keep the code the run decided.
  teardown: (exit, onExit) => onExit(Exit.isSuccess(exit) ? Number(process.exitCode ?? 0) : 2),
})
