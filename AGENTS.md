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
- Write the task text in English. Score it with the checker of the ste100 skill before you send it. Run `node <the skill folder>/dist/cli.js --dictionary resources/ste100-dictionary.json <file>`. The score must be 80 or more.
- Tell the worker to write each red test first and to run it on `master`.
- Check the report of a worker against the code. A claim without a file and a line is not evidence.
- Run `npx biome check .` on the branch of a worker yourself. A worker report of a clean lint is not evidence, because three branches failed `biome format` after such a report. Format every new test file.
- A worker commits on its own branch. It does not push and does not open a pull request.
- Change `GLOSSARY.md`, the ADR and `README.md` in the same change as the code.
- Run one `npm run check` at a time on the machine. A check starts real workers and real panes, and two checks load the machine twice. The orchestrator runs the full check. A worker runs the lint, the type check, `npm run ste100` and the test files of its own change.

## Commands and tools

- Run every test with `env -u OMP_WORKER_SESSION_DIR -u PI_SESSION_FILE`. These variables make 5 unit tests fail.
- Run GitNexus impact with `--repo omp-wezterm-worker`. Without it the command prints an error that a filter can hide.
- `finalizeJob` has CRITICAL impact and `stopJob` has HIGH impact. Keep a change in them small.
- `package.json` has `eol=crlf`. After an edit, run `git add --renormalize package.json` and `npx biome format --write package.json`.
- Read a file before an edit and copy its tag. Never invent a tag.
- OMP reads the configuration once at start. A change of code or configuration needs a restart of OMP.

## Git

- Do not push `master`. Use a branch and a pull request.
- Merge with `gh pr merge N --rebase`. Delete the branch by hand, because the repository does not delete it.
- Stage files by name. Never run `git add -A`.
- Do not merge a pull request without approval of the owner. Do not delete a worktree without it.

## Documents

- Keep each document that an agent reads at a score of 80 or more. Run `npm run ste100`.
- Add a new agent document to `CHECKED_DOCUMENTS` in `tooling/ste100-docs.ts`.
- Update the layout in `README.md` when you add or move a module.

## Before you report done

- Run `npm run check`. It runs the lint, the type check, the scores and every test. Run it one time, and not while another check runs.
- The integration tests need `omp` and `wezterm`. Report a test that did not run.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **omp-wezterm-worker** (1627 symbols, 4926 relationships, 130 execution flows). Use GitNexus graph tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact analysis before editing.** Use `impact({target: "symbolName", direction: "upstream"})` (MCP) or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .` (CLI fallback); report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). For regression review: `detect_changes({scope: "compare", base_ref: "master"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "master" --repo .`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/omp-wezterm-worker/context` | Codebase overview, check index freshness |
| `gitnexus://repo/omp-wezterm-worker/clusters` | All functional areas |
| `gitnexus://repo/omp-wezterm-worker/processes` | All execution flows |
| `gitnexus://repo/omp-wezterm-worker/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`hiennm11/omp-wezterm-worker`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.
