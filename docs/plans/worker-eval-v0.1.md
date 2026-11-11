# Worker Eval v0.1

Status: approved scope. Ready for implementation.
The scope is a benchmark of the worker flow of this repository.
The scope is not a router, not a learning policy, and not a second orchestrator.

## 1. Scope

The benchmark runs one task with one model and one effort level.
It records the execution, the verification and the usage.
It reports which configuration works best for one task type.

The benchmark lives in `tooling/eval/`. It stays in this repository.
It uses the launch lifecycle, the `Job` model, `UsageState` and the test host.
It adds no harness adapter, no schema package and no task analyzer.

Non-goals for v0.1:

- No runtime routing and no policy that changes itself.
- No LLM that scores code quality.
- No automatic retry or escalation of a worker.
- No dashboard and no database.
- No benchmark of a different harness.

## 2. What the implementation reuses

| Need | Existing module | How the benchmark uses it |
| --- | --- | --- |
| Start a worker | `wezterm_spawn_worker` through `tests/harness.ts` | One spawn per experiment. |
| Read status | `wezterm_worker_status` through `tooling/trial-scenario.ts` | `readRow` gives status, turns, elapsed time, transcript and usage. |
| Read output | `wezterm_worker_result` | The final text goes into the record as evidence, not as a verdict. |
| Launch rules | `extensions/lib/limits.ts` | The runner cannot exceed `maxActiveWorkers` or `maxLaunchesPerRequest`. |
| Usage | `extensions/lib/usage.ts` | `UsageReport` is copied without change. |
| Host setup | `tests/harness.ts` | `createHost`, `sessionContext` and `host.fire`. |
| Verification pattern | `tooling/trial-scenario.ts` | `runCommand` returns the exit code and the output. |
| Isolation pattern | `tooling/trial-fixture.ts` | A fixture is a directory with a git baseline. |

The runner is a top-level process, like `tooling/trial.ts`.
A worker cannot start a worker. `extensions/lib/limits.ts` refuses it.
So the benchmark never runs inside a worker.

`createHost` points `OMP_WORKER_CONFIG_FILE` at a file that does not exist.
So the benchmark sees no preset. The model and the effort come from the plan only.

## 3. Three independent axes

Do not merge these axes. Each axis answers a different question.

| Axis | Field | Values | Question |
| --- | --- | --- | --- |
| Execution | `execution.outcome` | `completed`, `failed`, `cancelled`, `not_started` | Did the worker run to an end? |
| Verification | `verification.verdict` | `PASS`, `FAIL`, `BLOCKED` | Does the code meet the acceptance test? |
| Usage | `usage.state` | `measured`, `partial`, `unknown` | Is the cost and token data complete? |

The bare word "verdict" already has two meanings in this repository: the result of the communication check, and the decision of the monitor. This plan always writes "acceptance verdict" for the value `PASS`, `FAIL` or `BLOCKED`.

`job.status` never decides the acceptance verdict.
`completed` does not prove that the code is correct.
`failed` does not prevent a `FAIL` when the verifier can still run.
A cancelled run is not `BLOCKED` by default. The verifier still runs.

### Acceptance verdict rules

The acceptance verdict is a pure function of the evidence. The order matters.

1. `BLOCKED` when the worker did not start.
2. `BLOCKED` when the fixture copy failed.
3. `BLOCKED` when the verifier did not start or reached its timeout.
4. `PASS` when the verifier started and exited with code 0.
5. `FAIL` when the verifier started and exited with a non-zero code.

A cancelled run with an unchanged fixture and a test that fails is `FAIL`.
The execution axis still reports `cancelled`. Both facts stay visible.

A verifier that exits non-zero because the worker broke the imports is `FAIL`.
The environment could evaluate the code. The code is wrong.

## 4. Dataset

One directory per task:

```text
tooling/eval/datasets/
  dataset.json                  { "schemaVersion": 1, "version": "2026-11-11.1" }
  bugfix/
    bugfix-001/
      task.md                   The exact text that the worker receives.
      task.json                 { "taskType": "bugfix",
                                  "workerTimeoutMs": 900000,
                                  "verify": {
                                    "command": ["node", "--test", "test/math.test.mjs"],
                                    "timeoutMs": 60000,
                                    "expectBefore": "fail",
                                    "protectedPaths": ["test/"] } }
      fixture/                  The repository copy. No .git directory.
```

`workerTimeoutMs` is the deadline of the worker. The default is 900000.
`verify.timeoutMs` is the deadline of the verifier. The default is 60000.
`expectBefore` is the expected acceptance verdict on an untouched fixture.
The token `{dataset}` in `verify.command` becomes the absolute path of the task directory.

The planner runs the verifier once on every fresh fixture before the matrix starts.
A mismatch stops the plan. This check is the meaning of "the fixture is reproducible".

### Protected paths

A worker can delete a test file or weaken an assertion.
`node --test` with no test file exits with code 0, so an empty test set proves nothing.

Before the verifier runs, the runner copies every path in `verify.protectedPaths`
from the dataset template into the run fixture.
The record holds the list in `verification.restoredPaths`.
This rule is mandatory.

### Dataset source

The pilot uses three synthetic fixtures. They only prove the machinery.
The full dataset uses 30 tasks. The bugfix and testing tasks come from the git history of this repository.
A small synthetic fixture is allowed for an implementation task and for a refactoring task.

- A bugfix task reverts a commit that fixed a bug. The acceptance test is the test of that commit.
- An implementation task removes a small feature. The acceptance test is the test of the commit.
- A refactoring task reverts a rename or a split. The verifier also checks the structure of the code.
- A testing task removes a test. The acceptance test is the test that must return.

The fixture copy has no git history. The task text cannot name the fix,
and the fixture cannot show the commit message.

`expectBefore` can hold `pass` only for a refactoring task.
A test that passes before the work proves nothing by itself.
Such a task needs a structural check in the same command, for example a check that the old symbol is gone.

`fixtureChecksum` is the SHA-256 of the sorted list of `(relative path, file bytes)`.
`promptHash` is the SHA-256 of `task.md`.
Do not invent a prompt version number. The hash is the version.

The four task types are `bugfix`, `implementation`, `refactoring` and `testing`.
The plan does not include `architecture` or `research`.
Those two types need a human judgement, and v0.1 accepts only a mechanical verifier.

## 5. Experiment record

```json
{
  "schemaVersion": 1,
  "experimentId": "exp-0007",
  "runId": "eval-2026-11-11-1",
  "taskId": "bugfix-001",
  "taskType": "bugfix",
  "fixtureChecksum": "sha256:...",
  "promptHash": "sha256:...",
  "datasetVersion": "2026-11-11.1",
  "configuration": {
    "model": "omniroute/minimax/MiniMax-M3.1-Flash",
    "effort": "medium",
    "packageVersion": "0.1.0",
    "commit": "abc1234",
    "dirty": false
  },
  "timing": { "startedAt": 1762800000000, "finishedAt": 1762800042000 },
  "execution": {
    "started": true,
    "outcome": "completed",
    "jobId": "wz-mvhrdqg1-1",
    "status": "completed",
    "error": null,
    "stop": null,
    "turns": 14,
    "wallMs": 42000,
    "transcript": "<state>/sessions/wz-mvhrdqg1-1/....jsonl"
  },
  "verification": {
    "verdict": "PASS",
    "command": ["node", "--test", "test/math.test.mjs"],
    "exitCode": 0,
    "started": true,
    "timedOut": false,
    "durationMs": 3120,
    "restoredPaths": ["test/math.test.mjs"],
    "outputTail": "...."
  },
  "usage": {
    "state": "measured",
    "cost": 0.0123,
    "note": null,
    "totals": { "turns": {}, "sideCalls": {}, "calls": 15, "callsWithoutUsage": 0, "cost": 0.0123, "files": 1 }
  },
  "resultText": "...."
}
```

Rules for this record:

- `usage` holds the `UsageReport` of `extensions/lib/usage.ts` without change. Do not write it as one token number.
- `usage.cost` stays `null` when the state is not `measured`. Never write zero for an unknown cost.
- `cost` comes from the transcript only. Do not add a price table in v0.1.
- `execution.transcript` is evidence. It is not a verdict.
- `resultText` is the worker answer. It is not a verdict.

## 6. Artifacts

```text
.eval/<runId>/
  manifest.json                 environment, plan, dataset version, commit
  plan.json                     every planned experiment
  state/                        the test host state directory
  experiments/exp-0001.json     one record per run
  report.json                   the aggregate
```

`.eval/` goes into `.gitignore`. The JSON files are the source of truth.
After `report`, the writer also writes `docs/trials/worker-eval-<runId>.md`.
That file is small: the cell table, the environment, the commit and the dataset version.
Commit that file. Do not commit the JSON artifacts.

The runner writes one record after every run. A crash keeps the finished records.
`--resume` reads the existing records. It skips an experiment when the record exists and its `fixtureChecksum` matches.

`manifest.json` holds `node`, `omp`, `herdr`, `wezterm`, the OS, the package version, the git commit and the plan.

## 7. Plan and matrix

```text
node tooling/eval/cli.ts plan --pilot --out .eval/<runId>
node tooling/eval/cli.ts run  --run .eval/<runId>
node tooling/eval/cli.ts report --run .eval/<runId>
node tooling/eval/cli.ts recommend --run .eval/<runId> --task-type bugfix
```

`plan` takes `--dataset`, `--models`, `--efforts`, `--tasks`, `--pilot` and `--allow-dirty`.
It writes `plan.json` and prints the run count and the estimated queue time.
`--dry-run` stops after the fixture validation.

Pilot matrix: 3 tasks, 3 models, 2 efforts. 18 runs.
Full matrix: 30 tasks, 3 models, 3 efforts. 270 runs.

The source holds no default model. `plan` takes the three identifiers and writes them to the plan.
The pilot pins these three models:

- `omniroute/minimax/MiniMax-M3.1-Flash`
- `omniroute/cc/claude-haiku-5-5`
- `omniroute/cc/claude-opus-5-5`

The plan records the exact string that it sends.
The planner refuses a model string with an effort suffix (for example `...:xhigh`) when the effort is set.
The planner refuses an alias such as `auto/claude-sonnet`, because a router can choose a different model between two runs.

`plan` refuses a dirty work tree and names the changed files.
The flag `--allow-dirty` overrides the refusal.
The record then holds `dirty: true`, and the report prints a warning.

Concurrency is 1 by default. The hard ceiling is 3, because `createHost` gives the default `maxActiveWorkers`.
Use `--concurrency 2` only after the pilot proves fixture independence.
Every experiment calls `host.fire("input", {})` before the spawn.
This call resets `maxLaunchesPerRequest`. `maxActiveWorkers` still applies.

Each run uses a fresh copy of the fixture in `.eval/<runId>/fixtures/<experimentId>/`.
The copy has its own git baseline. Do not use `isolated: true`.
ADR 0002 forbids the automatic deletion of a worker worktree, and the benchmark does not need one.

## 8. Report

`report.json` holds one cell for each `(taskType, model, effort)`:

```json
{
  "taskType": "bugfix",
  "model": "omniroute/minimax/MiniMax-M3.1-Flash",
  "effort": "medium",
  "runs": 10,
  "pass": 8,
  "fail": 1,
  "blocked": 1,
  "valid": 9,
  "successRate": 0.889,
  "usageMeasured": 8,
  "usageUnknown": 1,
  "medianWallMs": 41000,
  "medianTurns": 13,
  "costKnownSum": 0.0934,
  "costComplete": false
}
```

`successRate` is `pass / valid`. `blocked` is not a failure and stays out of the denominator.
`costComplete` is true only when every run has `usage.state = measured`.
A cell with `costComplete: false` shows no total cost. It does not show a partial sum as a total.

The terminal output is a table of the cells of one task type.
The order is `successRate` descending.

## 9. Recommend

`recommend` ranks the eligible cells of one task type.

A cell is eligible when both conditions hold:

- `valid >= 3`
- `valid / runs >= 0.8`

Rank order:

1. `successRate` descending.
2. `usageMeasured` descending.
3. `costKnownSum` ascending, when `costComplete` is true. A cell with incomplete cost is last.
4. `medianWallMs` ascending.

The output names the evidence and the run:

```text
Task type: bugfix
Recommended: omniroute/minimax/MiniMax-M3.1-Flash, effort medium
Evidence: 8/9 valid runs passed, median 41 s, 8/9 runs with measured usage
Fallback: <the second eligible cell>
Run: eval-2026-11-11-1, dataset 2026-11-11.1, commit abc1234
```

There is no policy engine in v0.1. The recommendation is a report over one benchmark run.
A human approves a change to the default configuration.

## 10. Modules and file budget

Every file stays below 350 lines. `tests/architecture.test.ts` enforces this.

| File | Responsibility | Pure |
| --- | --- | --- |
| `tooling/eval/cli.ts` | Arguments, dispatch, exit codes | no |
| `tooling/eval/types.ts` | Dataset, plan, record and report types | yes |
| `tooling/eval/dataset.ts` | Scan, validate, checksum, fixture copy | no |
| `tooling/eval/planner.ts` | Matrix, run count, pilot selection | yes |
| `tooling/eval/runner.ts` | One experiment through the test host | no |
| `tooling/eval/verifier.ts` | Command, exit code, verdict | partly |
| `tooling/eval/artifact.ts` | JSON read, JSON write, resume | no |
| `tooling/eval/report.ts` | Aggregate the records | yes |
| `tooling/eval/recommend.ts` | Eligibility and ranking | yes |
| `tooling/eval/format.ts` | Terminal table and text lines | yes |

The planner, the verdict, the report and the recommendation are pure functions.
A unit test checks them without a pane and without a worker.

Exit codes: `0` for a completed command, `1` for an internal error, `2` for a usage error or a missing program.
A `FAIL` verdict is data. It is not an error exit code.

## 11. Tests

Add these test files and name them in the `test:unit` script:

| Test file | Checks |
| --- | --- |
| `tests/eval-dataset.test.ts` | A checksum is stable. A malformed dataset is refused. A protected path is restored. |
| `tests/eval-planner.test.ts` | The pilot has 18 runs. The full matrix has 270. No duplicate cell. |
| `tests/eval-verdict.test.ts` | The five acceptance verdict rules. `completed` plus exit code 1 is `FAIL`. A cancelled run with a failing verifier is `FAIL`. No start is `BLOCKED`. |
| `tests/eval-report.test.ts` | `successRate` excludes `blocked`. An unknown cost stays `null` and `costComplete` is false. |
| `tests/eval-recommend.test.ts` | The eligibility limits. The tie-break order. An incomplete cost cannot win on cost. |

The benchmark itself is not part of `npm run check`.
18 real workers and real panes are too slow for a check.
Run the pilot by hand and keep its artifacts.

## 12. Acceptance criteria

| Slice | Observable result |
| --- | --- |
| Dataset | `plan --dry-run` validates every fixture and stops on a broken one. |
| Planner | The pilot prints 18. The full matrix prints 270. |
| Runner | One run writes one `experiment.json` with all three axes. |
| Verifier | A good fixture gives `PASS`. A broken fixture gives `FAIL`. A missing program gives `BLOCKED`. |
| Protected paths | A worker that deletes `test/` still gives `FAIL`, not `PASS`. |
| Dirty tree | `plan` refuses a dirty tree and accepts `--allow-dirty`. |
| Report file | `report` writes `docs/trials/worker-eval-<runId>.md`. |
| Artifact | `--resume` skips a finished record and repeats an incomplete one. |
| Report | A cell with one `blocked` run has `valid = runs - blocked`. |
| Recommend | An ineligible cell never appears as the recommendation. |

## 13. Implementation order

1. `types.ts` and `dataset.ts`. The dataset is the first contract.
2. `planner.ts` with the pure tests.
3. `artifact.ts` and `manifest.json`.
4. `runner.ts` with one real task.
5. `verifier.ts` and the verdict rules.
6. `report.ts`, `recommend.ts` and `format.ts`.
7. The pilot of 18 runs. Do not use the pilot to select a model.
8. The full matrix, only after the pilot passes the acceptance criteria.

## 14. Documents to update with the code

- `README.md`: the repository layout and one section about the benchmark.
- `GLOSSARY.md`: experiment, benchmark run, acceptance verdict, dataset version, fixture checksum, protected path, measured cost.
- `tooling/ste100-docs.ts`: add this plan and the new README section.
  This file is code, so the implementation registers the plan later.
- `.gitignore`: add `.eval/`.
- v0.1 needs no ADR. The architecture decision is this plan.
