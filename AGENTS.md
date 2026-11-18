# Rules for this repository

These rules add to the global rules in `~/.agents/AGENTS.md`. The tests in
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

- Start a program only through `rt.exec`, `rt.herdr` or `rt.git`.
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
  `deadlineMessage` in `lib/monitor.ts` and `decideFromReports` in
  `lib/report-decision.ts` are the model.
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

## Workers and the orchestrator

- Give the implementation to a worker with `isolated: true`. The orchestrator keeps the grilling, the facts, the task text and the verification.
- Put the full design in the task text. A worker cannot read the conversation.
- Write the task text in English. Score it with the checker of the ste100 skill before you send it. Run `node <the skill folder>/dist/cli.js <file>`. The score must be 80 or more.
- Tell the worker to write each red test first and to run it on `master`.
- Check the report of a worker against the code. A claim without a file and a line is not evidence.
- Run the pinned biome on the branch of a worker yourself: `D:/repos/omp-wezterm-worker/node_modules/.bin/biome check .`. A worktree without `node_modules` takes a different biome from `npx`, and that binary reported a clean lint on a branch that failed the repository lint. Run `npm run lint` again on the main checkout after the merge. A worker report of a clean lint is not evidence. Format every new test file.
- Run the unit list yourself as well. Three worker reports named 23 to 26 failing tests that do not occur when the orchestrator runs the same list on the same commit. A worker count of failures is not evidence either.
- A worker commits on its own branch. It does not push and does not open a pull request.
- Change `GLOSSARY.md`, the ADR and `README.md` in the same change as the code.
- Run one `npm run check` at a time on the machine. A check starts real workers and real panes, and two checks load the machine twice. The orchestrator runs the full check. A worker runs the lint, the type check, `npm run ste100` and the test files of its own change.

## Commands and tools

- Run every test with `unset OMP_WORKER_SESSION_DIR PI_SESSION_FILE` first. The `env -u` form fails in the Git Bash of this machine with `exec: node: not found`. These variables make 5 unit tests fail.
- An isolated worktree holds no `node_modules`. Run `npm ci` there before a check. Without it, `npx biome` installs biome 0.3.3, so a lint report from that worktree means nothing.
- The worker eval lives in `tooling/eval/`. Read `skills/worker-eval/SKILL.md` before a benchmark. It starts real workers in panes, one experiment at a time.
- `package.json` has `eol=crlf`. After an edit, run `git add --renormalize package.json` and `npx biome format --write package.json`.
- Read a file before an edit and copy its tag. Never invent a tag.
- OMP reads the configuration once at start. A change of code or configuration needs a restart of OMP.

## Git

- Do not push `master`. Use a branch and a pull request.
- Wait until `gh pr view N --json mergeable` reports `MERGEABLE` before the merge. A merge that starts while GitHub still reports `UNKNOWN` fails, and the failure can close the pull request.
- Merge with `gh pr merge N --rebase`. Read the state after the merge. Delete the branch by hand only when the state is `MERGED`, because a deleted branch closes the pull request.
- Stage files by name. Never run `git add -A`.
- Do not merge a pull request without approval of the owner. Do not delete a worktree without it.

## Documents

- Keep each document that an agent reads at a score of 80 or more. Run `npm run ste100`.
- Add a new agent document to `CHECKED_DOCUMENTS` in `tooling/ste100-docs.ts`.
- Update the layout in `README.md` when you add or move a module.

## Before you report done

- Run `npm run check`. It runs the lint, the type check, the scores and every test. Run it one time, and not while another check runs.
- The integration tests need `omp`, `herdr` and a Herdr session. Run them in a throwaway session with `HERDR_SOCKET_PATH` set to that session, so that a test never touches the panes of your own session. Report a test that did not run.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`hiennm11/omp-wezterm-worker`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.
