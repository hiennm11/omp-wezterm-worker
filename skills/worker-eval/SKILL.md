---
name: worker-eval
description: Use when benchmarking worker models or when deciding which model and thinking level to use for a task. Covers the worker eval in tooling/eval: the dataset, the plan, the run, the report and the recommendation. Triggers on worker eval, model benchmark, which model, which effort, thinking level, compare model configurations, eval run, recommend a model.
---

# Worker eval

The worker eval measures how well a model solves a task with a given thinking level. It runs real workers through the extension and verifies the result with a test, not with the report of the worker.

The source lives in `tooling/eval/`. The design is `docs/plans/worker-eval-v0.1.md`.

## What it measures

Each experiment records three independent axes:

- Execution: `completed`, `failed`, `cancelled` or `not_started`.
- Acceptance verdict: `PASS`, `FAIL` or `BLOCKED`, from an external verifier.
- Usage: `measured`, `partial` or `unknown`.

The job status never decides the verdict. A worker can report `completed` and still fail the test. A worker can fail at its deadline after it fixed the code, and the verifier still gives `PASS`.

`BLOCKED` means that the environment could not evaluate the code. A blocked run is not a failure.

## The four commands

```text
node tooling/eval/cli.ts plan --dataset tooling/eval/datasets \
  --models "omniroute/minimax/MiniMax-M3.1-Flash,omniroute/ds/deepseek-v4-flash" \
  --efforts "low,medium,high" --out .eval/eval-1

node tooling/eval/cli.ts run --run .eval/eval-1

node tooling/eval/cli.ts report --run .eval/eval-1
node tooling/eval/cli.ts recommend --run .eval/eval-1 --task-type bugfix
```

`plan` writes `plan.json` and `manifest.json`. `run` writes one record per experiment. `report` writes `report.json` and a summary in `docs/trials/`. `recommend` ranks the cells of one task type.

Options: `plan` takes `--pilot`, `--dry-run` and `--allow-dirty`. `report` takes `--task-type` and `--summary-dir`. `run` takes `--concurrency`, and the value must be 1.

Exit code 0 means the command finished. A `FAIL` verdict is data, not an error exit code. Exit code 2 means a usage error, a dataset error or a refusal.

## The dataset

`tooling/eval/datasets/<type>/<taskId>/` holds:

- `task.md`: the exact text that the worker receives.
- `task.json`: `taskType`, `workerTimeoutMs`, and `verify` with `command`, `timeoutMs`, `expectBefore` and `protectedPaths`.
- `fixture/`: the small repository that the worker changes. No `.git`.
- `solution/`: the correct files. The loader never copies this tree to the run fixture. A script uses it to prove that the task passes after the work.

The four types are `bugfix`, `implementation`, `refactoring` and `testing`. A refactoring task runs a structural check. A testing task runs the new test against a mutated copy.

## The artifacts

```text
.eval/<runId>/
  plan.json
  manifest.json
  experiments/<experimentId>.json
  fixtures/<experimentId>/
  state/
  report.json
```

Commit the generated summary in `docs/trials/`. Do not commit the JSON artifacts. `.eval/` is ignored.

## Rules that keep a run valid

1. Pin a concrete model id. The planner refuses an `auto/` alias and a `:effort` suffix.
2. Use one model and one thinking level per cell. The effort is the thinking level.
3. Run one experiment at a time. A worker starts a real pane and a real process.
4. Run in a throwaway Herdr session. Set `HERDR_SOCKET_PATH` to that session, so the run never touches the panes of the user.
5. Use a clean work tree. `plan` refuses a dirty tree. `--allow-dirty` records `dirty: true`, and the report warns.
6. Put the reporting instruction in `task.md`. Without it, a worker that fixes the code ends its turn in silence, and the supervisor marks it `failed` at the deadline.
7. Do not trust a small run. A cell needs 3 valid runs and a valid share of 0.8 before `recommend` uses it.
8. Do not edit a summary that the tool generated.

## Presets and configuration

The eval takes the model and the effort as arguments. It does not read the presets of the extension.

A preset is a poor fit for a benchmark. A preset can hold a role alias such as `task`, and OMP resolves that alias to a different concrete model over time. A preset can also set a thinking level, and that would override the effort of the matrix.

The configuration that the eval reads is in the dataset and the environment:

- `workerTimeoutMs` and `verify.timeoutMs` per task.
- `protectedPaths` per task.
- `HERDR_SOCKET_PATH` for the pane session.
- `--summary-dir` for the summary.

The extension configuration still bounds the run. A test host starts with the default `maxActiveWorkers` of 3.

## Windows traps

- Run a test with `unset OMP_WORKER_SESSION_DIR PI_SESSION_FILE`. The `env -u` form fails in the Git Bash of this machine.
- In a worktree without `node_modules`, run the pinned biome: `D:/repos/omp-wezterm-worker/node_modules/.bin/biome check .`.
- `node --test` exits with code 0 when it finds no test file. A verifier must restore the protected paths, and a testing task must use a mutation check.

## Before you trust a number

- Read the records, not only the table. Check `execution.outcome`, `verification.verdict` and `usage.state` for a sample.
- A cost of `null` means that the transcript held no price. It is not zero.
- A run where every configuration passed says nothing about a model. Use a harder task before you draw a conclusion.
- The current dataset is too easy. The full matrix of 360 runs passed 358 times, so the ranking followed the median time. Do not spend hours on this dataset to choose a model.
