# Backend proof evidence

Status: the Claude Code backend passes every fixed scenario. The Codex backend is not proven.

This report records what the compatibility probe observed on Windows native. The raw evidence and the probe code live in the evidence directory that the report names.

## Installed programs

| Program | Version | Path |
| :- | :- | :- |
| node | v22.19.0 | on PATH |
| claude | 2.1.306 (Claude Code) | on PATH |
| codex | codex-cli 0.142.0 | on PATH |
| wezterm | 20240203-110809-5046fc22 | on PATH |
| omp | 18.12.5 | on PATH |

The plan observed Claude Code 2.1.305 and Codex CLI 0.157.1. The installed Claude Code moved to 2.1.306. The Codex version that the plan observed is not the one that `codex` resolves on this machine.

The proof used the installed build. It read the generated declarations of that build and not the published documentation.

## The Claude Code bridge

The worker loads a session-scoped mod. The mod validates against the installed CLI:

```
Validating plugin manifest: <evidence-dir>/claude-mod/.claude-plugin/plugin.json
Validating hooks: <evidence-dir>/claude-mod/hooks/hooks.json
  > ./register.js hooks: session.start, prompt.submit, turn.start, turn.complete,
    tool.call, tool.check, session.append, tool.call{tool=...wezterm_worker_report}
```

The mod keeps its state in the closure of `register`. It imports no Node module. It reads the address of the owner and its token from the environment of the session. Every observer passes `next(e)` unchanged. The mod registers no handler that can approve a tool.

The owner talks to the mod over a loopback HTTP server. The server binds only to `127.0.0.1` on an OS-assigned port. Every request carries `Authorization: Bearer <per-run-token>`.

## The scenarios

| Scenario | Verdict | Native evidence |
| :- | :- | :- |
| observe | pass | A real TUI, a native session id, a paired read call and result, a report bound to the run and to the cycle. |
| queue | pass | The foreground command ran its full 15 seconds. One accepted entry became a delivered input. The first cycle could not finish the run. The final report belonged to the later cycle. |
| direct-input | pass | Native ingress and native delivery of the instruction in the same run. |
| approval | pass | One native request, one settlement, no denial. The command ran once. The queued control was refused while the request was open. |
| background | pass | One background settlement apart from three foreground settlements. The background file exists. |
| no-report | pass | The turn ended. No completed task verdict. |
| resume | pass | The same native session. A new run id and a new cycle. The earlier report could not complete the new run. |
| recovery | pass | One native session start. No replacement worker. The report after the reconnect settled the cycle. |
| stop | pass | The pane is gone, the Claude process count fell, the unrelated pane survived. |
| settings-usage | pass | The measured fields are `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and `model`. |

## The native facts that the implementation uses

These are the observed facts. Each one is a runtime fact of the installed build, not a source expectation.

The report tool registers through the native mod interface. Its input fields are `state`, `result`, `dependency`, `resumeCondition`, `needs`, and `detail`. A state-specific field stays required.

`$.prompt.submit` does not raise the `prompt.submit` event. An instruction that the mod submits reaches the transcript as a user row that names the plugin. The native delivery of a queued instruction is therefore proven by that row, and not by a receipt.

`$.prompt.submit` resolves when the session is free. A submit that happens while a tool runs waits for the tool. The native acceptance is therefore recorded at the call, and the native delivery at the row that carries the instruction.

The modern permission path does not raise `classic.PermissionRequest`. The permission decision of `tool.check` carries `decision: "ask"` when the session waits for the person. That decision is the native request evidence, and the settlement of the same call is the native resolution evidence.

A background task ends in a transcript row whose `origin.kind` is `task-notification`. That row is separate from the row of the foreground tool result, so the two settlements stay apart.

A native turn reports its usage in the `turn.complete` event. The measured fields are the five that the table names. A field that the build does not report stays missing.

The session startup asks two questions: the trust of the workspace and the MCP servers of the project. The proof answers both in the pane. The MCP servers come from the global configuration of the user, so the proof enables them. The feature contract requires that a worker keeps the integrations of the user.

A permission bypass that the user already configured stays in place. The proof scenario for approvals used a session-scoped `--settings` file, because the global configuration of this machine sets `permissions.defaultMode` to `bypassPermissions`. The proof never changed a global setting.

## The implementation contract

| Behavior | The contract that the observation gives |
| :- | :- |
| launch | `claude --session-id <uuid> --plugin-dir <absolute-plugin-path>` in a WezTerm pane, with the fixture as the working directory. A model that the user names is passed through unchanged. |
| report binding | The mod binds the report to the run id and to the native turn id. The supervisor accepts a report only for the current cycle. |
| accepted input | The native acceptance of `$.prompt.submit` adds the instruction id to the pending input. |
| delivered input | The transcript row that names the plugin starts the cycle and clears the pending instruction. |
| current cycle | The native turn id of the last `turn.start`. |
| pending queue | The instruction ids that the native program accepted and that no cycle carries yet. |
| tool settlement | The `tool.call.settled` event of the same call id. |
| background execution | The `session.append` row whose `origin.kind` is `task-notification`. |
| approvals | The `tool.check` decision `ask` and the settlement of the same call id. |
| history | The native session id. A resume reuses it. |
| usage | The `usage` object of the `turn.complete` event. |
| reconnect | The bridge reconnects. The native session keeps its identity. |
| stop | The pane list shows the pane gone and the Claude process count fell. |

## The Codex backend

The Codex backend is not proven. The proof of it needs a dedicated app server, a generated protocol schema, a real TUI that attaches to that server, and a report server that the TUI loads.

The version that `codex` resolves on this machine is 0.142.0. The plan observed 0.157.1. A node `spawn` of `codex` reaches a different binary than `cmd /c codex`, so the probe must resolve the binary before it plans around a protocol version.

Ticket 1 stays open. Tickets 2 to 5 stay blocked for the Codex half of the feature.

## The production Claude Code backend

The proof established the contracts. The production code uses them. This section records what the production run observed, apart from the proof.

The smoke run `tooling/claude-smoke.ts` starts a real Claude Code session through the spawn tool and checks the whole path. Its result on Windows native:

| Check | Result |
| :- | :- |
| The worker reports its task | The report file holds `{"runId":"wz-...","cycleId":"...","state":"completed","result":"SMOKE-OK"}`. The status shows the result and the backend. |
| An explicit tool list | The spawn refuses it: "The tools parameter applies to an OMP worker only." |
| A backend that is not implemented | The spawn refuses it: "The backend 'codex' is not implemented." The extension never falls back to OMP. |
| A resume | The resumed run reuses the native session id, gets a new run id, and reports `RESUME-OK`. |
| A steering instruction | The instruction goes through the bridge, the native session queues it, and the worker reports `STEER-OK`. |

The production run found four facts that the proof did not show, because the proof never ran the production path.

The report tool is called under its MCP name. The native host calls `mcp__wezterm-worker__wezterm_worker_report`, and a handler that matches the plain name `wezterm_worker_report` never fires. The mod registers both names.

A resumed session continues with `--resume <id>`. The flag `--session-id` creates a new session, and the CLI refuses it with "Session ID is already in use" when the id exists.

A resumed session takes no new prompt as an argument. The follow-up instruction goes into the composer of the pane, the way the user types it. The text and the Enter go in two steps, and the composer settles before the Enter arrives.

A native session keeps its id while it runs. A resume that starts before the old process ended is refused by the CLI, so the resume waits for the process of the source run to go.

## The capability gaps

The proof of the Claude Code backend found no gap in the required contracts. The gaps sit in the areas that the plan reserved for the Codex backend and in the areas that the feature adds later.

The stop of a Claude worker is confirmed by the pane list and by the process count. The proof did not read a native interruption event of the Claude session, because the installed build raises none that the mod can observe. The contract uses the pane and the process, and the pane text stays a diagnostic.

The report of the main loop settles the task. The proof did not exercise a child loop that reports, so the rule that a child loop cannot complete the main task rests on the design and not on an observation.

The proof never used a permission bypass flag. The `bypassPermissions` mode of the global configuration of this machine means that a real session asks for no permission at all, so the proof created its own ask rule for the approval scenario.

The production mod registers the report tool under two names. The installed CLI refuses a mod that registers the same event twice without a matcher, so the mod has one handler per name and the validator checks the mod before every launch.
