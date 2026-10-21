# Rules for this repository

These rules add to the global rules in `~/.omp/agent/AGENTS.md`. The tests in
`tests/architecture.test.ts` enforce the rules that a test can check.

## Structure

- Keep each source file at 350 lines or fewer.
- Split a file by responsibility when it grows. Do not split it only to reduce the count.
- Put worker behaviour in `extensions/lib/`. Put one tool in one module in `extensions/worker-tools/`.
- Keep `extensions/wezterm-worker.ts` as wiring only. It holds no worker logic.
- Never import the entry or `worker-tools/` from `lib/`. The dependency points one way.
- Put the scripts of the repository in `tooling/` or `scripts/`. Never put a script in
  `tools/`, `commands/`, `rules/`, `prompts/`, `agents/` or `hooks/`. OMP imports every
  module of these directories as a custom tool and runs it when the plugin loads.

## Dependencies

- Start a program only through `rt.exec`, `rt.wezterm` or `rt.git`.
- Import `node:child_process` only in `extensions/lib/process.ts`.
- Keep shared state in `WorkerRuntime`. Do not add a module-level variable.
- Create the runtime once, in the entry. A tool receives it through `ToolDeps`.

## Tools

- Add a new tool as a new module in `worker-tools/`. Register it in the entry.
- Find the worker with `findJob`. Build every reply with `reply`.
- Do not copy the "Unknown worker id" block.
- Do not change a tool name, a tool schema or the `registry.json` format without an ADR.

## Logic and tests

- Write a decision as a pure function of the job and the clock. Test it without a pane.
  `deadlineMessage` and `finishedResult` in `lib/monitor.ts` are the model.
- Add a test only for a behaviour that a user can observe.
- Do not delete a worker's work. See `docs/adr/0002-never-delete-a-workers-work.md`.

## Comments

- Prefer code that explains itself.
- Do not write a comment that repeats the implementation or describes an obvious function behavior.
- Write a comment only for a non-obvious intent, a constraint, an invariant, or a workaround.
- Explain why, not a line-by-line how.
- When you change behavior, update or remove the affected comments.
- Treat a comment as a claim that can be out of date. Verify it against the implementation and the tests.
- Report a conflict between a comment and the code. Do not assume that either one is correct.
- Apply this rule to the code you write or change. Do not scan the whole repository to remove comments.
- When you change code, update or remove only the related comments that are out of date.
- Do not change logic only to satisfy this rule.

## Documents

- Keep each document that an agent reads at a score of 80 or more. Run `npm run ste100`.
- Add a new agent document to `CHECKED_DOCUMENTS` in `tooling/ste100-cli.ts`.
- Update the layout in `README.md` when you add or move a module.

## Before you report done

- Run `npm run check`. It runs the lint, the type check, the scores and every test.
- The integration tests need `omp` and `wezterm`. Report a test that did not run.
