# effect-bench

- Node `>=24`, `pnpm`. Effect v4 (`effect@4.1.2`); read the installed source under `node_modules/effect/src` instead of relying on v3 patterns.
- `pnpm check` formats, lints, typechecks and tests. `pnpm bench -- <args>` runs the CLI from source.
- Packages run from `.ts` source directly (Node type stripping): keep syntax erasable and import local files with `.ts` extensions.

## Measuring a change with effect-bench

1. `effect-bench list --json` to find bench ids.
2. `effect-bench run <filter> --save before --json` on the current code.
3. Make the change.
4. `effect-bench run <filter> --compare before --json` and read each record's `comparison.verdict`; the final `summary.exitCode` is 1 on a regression.
5. Treat `inconclusive` or small `slower` changes on `--quick` as noise until confirmed with `--rigorous`.
