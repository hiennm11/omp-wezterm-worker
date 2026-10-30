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

A second probe (2026-10-23, Claude Code 2.1.309, model haiku, one real worker in a WezTerm pane) read the raw events. The worker ran one background command and one foreground command. The probe mod posted every raw event and changed none. These are the facts.

- The raw `tool.call` event of a background command has the fields `command`, `description`, `run_in_background`, `tool` and `tool_use_id`. The field `run_in_background` is `true`. The raw event of the foreground command has the same fields without `run_in_background`.
- The raw `session.append` event of the notification has the fields `message`, `door`, `origin` and `uuid`. The field `origin.kind` is `task-notification`.
- The text of the notification (`message.content[0].text`) holds the elements `<task-id>`, `<tool-use-id>`, `<output-file>`, `<status>` and `<summary>`. The element `<tool-use-id>` equals the `tool_use_id` of the call that started the task. The probe shows this for one task.
- The notification arrived 20.1 seconds after the start of the session. The call `tool.call` arrived at 4.4 seconds. The command slept 12 seconds.
- The production mod forwards neither fact. It sends `command` but not `run_in_background` in `tool.call.opened`. It sends `uuid`, `door` and `originKind` but not the text of the notification in `background.settled`. So the supervisor cannot link the notification to its call (issue 30).
- The probe covers one background task. It does not show a task that fails, a task that the user cancels, or two tasks that run at the same time.

A third probe (2026-10-28, Claude Code 2.1.309, one real worker in a WezTerm pane) read the raw events of a background task and of a stop of a background task. The probe mod posted every raw event and changed none. These are the facts.

- The foreground `tool.call.settled` observation of a background call arrives at once. The task still runs at that moment. The settlement of the call is not the settlement of the task.
- The result of a background call is a `session.append` row whose `origin.kind` is `tool` and whose `origin.tool` is `Bash`. Its `message.content[0]` holds a block of the type `tool_result`. The text of the block starts with `Command running in background with ID: <task-id>.`. The text after `ID: ` up to the next period is the id of the task.
- A background task ends in a `session.append` row whose `origin.kind` is `task-notification`. Its `message.content[0].text` holds these tags on separate lines: `<task-id>`, `<tool-use-id>`, `<output-file>`, `<status>` and `<summary>`. The `<tool-use-id>` equals the `tool_use_id` of the call that started the task.
- The probe saw two values of `<status>`: `completed` for a task with the exit code 0, and `failed` for a task with the exit code 3. Each notification names its own call id. Three tasks ran at the same time, and each got its own notification.
- A task that the worker stops with the tool `TaskStop` sends no notification. The probe stopped `sleep 600`, and no row with the origin kind `task-notification` ever came. The `TaskStop` call has the fields `task_id`, `tool` and `tool_use_id`. Its result is a `session.append` row whose `origin.kind` is `tool` and whose `origin.tool` is `TaskStop`. The text of the result is the JSON text `{"message":"Successfully stopped task: <task-id> (sleep 600)","task_id":"<task-id>","task_type":"local_bash","command":"sleep 600"}`.
- The probe did not cover a task that the user stops with a key in the pane. It did not cover a stop with another tool. It did not cover a task that still runs when the worker ends. It did not cover a value of `<status>` other than `completed` and `failed`. The supervisor keeps the row open in each of these cases, because the data that links the task is missing.

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
| background start | The `session.append` row whose `origin.tool` is `Bash` and whose text names the id of the task. |
| background stop | The `session.append` row whose `origin.tool` is `TaskStop` and whose JSON text names the id of the task. |
| approvals | The `tool.check` decision `ask` and the settlement of the same call id. |
| history | The native session id. A resume reuses it. |
| usage | The `usage` object of the `turn.complete` event. |
| reconnect | The bridge reconnects. The native session keeps its identity. |
| stop | The pane list shows the pane gone and the Claude process count fell. |

## The Codex backend

The Codex backend is not proven. The proof of it needs a dedicated app server, a generated protocol schema, a real TUI that attaches to that server, and a report server that the TUI loads.

The probe ran once on 2026-10-29. The run failed. It printed `FAIL observe: turns started: 1, completed: 0, report: missing`. The run left only `report.md` and `versions.json`. A failed run gives no raw evidence, so nobody can find why the turn did not finish.

The run now leaves `observations.jsonl`. The file holds one line for each protocol message of the app server, in both directions. The file also holds the text of the pane of the TUI. The proof of the Codex backend stays open.

The first run failed because the thread had no rollout file. The request `thread/start` makes a thread without a rollout file on the disk. The answer of that request names the path of the file, and the file does not exist at that moment.

The command `resume` of the TUI calls the method `thread/resume`. The server answers that method with the error `no rollout found for thread id <id>` and the code -32600. The TUI exits with the code 1 in less than one second. The pane then holds no TUI. Nobody answers the approval of the report tool. The scenario `observe` fails with `turns started: 1, completed: 0, report: missing`.

The next order of calls fixes this.

1. The client sends `initialize` with the capability `experimentalApi`, and then the notification `initialized`.
2. The client sends `thread/start` with the working directory and the model.
3. The client sends `thread/name/set` with the thread id and the name `proof-worker`. This call writes the rollout file at once.
4. The client sends `thread/resume` with the thread id. The answer carries no error.
5. The TUI starts in a pane with the same argument list as before.
6. The client sends `turn/start` with the task text.

The request `thread/inject_items` also writes the rollout file, but it puts the task text into the model history twice. The proof does not use it.

A probe on the machine of this repository confirmed the order. The probe used the build codex-cli 0.165.0. The TUI stayed alive for more than 80 seconds. It showed the task and the approval dialog `Allow the wezterm_worker_proof MCP server to run tool "wezterm_worker_report"?`. The dialog holds the options `1. Allow`, `2. Allow for this session`, `3. Always allow` and `4. Cancel`. The TUI used the thread id of the client.

The scenario `observe` answers that dialog. The proof reads the text of the pane every second. When the dialog shows, the proof sends the Enter key to the pane, and the first option lets the call run. The proof records the observation `tui.approval-answered` with the text that showed the dialog.

The other scenarios keep their behaviour. A scenario that tests an approval or a refusal does not answer.

### The two dialogs of the Codex TUI

The TUI of Codex shows two different dialogs. The first dialog asks for the approval of a call of the report server. The second dialog asks for the approval of a shell command.

| Dialog | The text that marks it | The first option | The key |
| :- | :- | :- | :- |
| The call of the report server | `Allow the wezterm_worker_proof MCP server to run tool` | `1. Allow` | Enter |
| A shell command | `Would you like to run the following command?` | `1. Yes, proceed (y)` | Enter |

The first option of each dialog is the default. The key Enter selects it.

The dialog of a shell command asks for the approval before the model starts a background job. A turn can hold both dialogs, so a proof that answers one dialog can stop at the other one.

The proof reads the text of the pane every second. The function `dialogKind` finds the dialog that the pane shows. When both dialogs show, the function returns the dialog that appears last in the text, because the newest dialog of the TUI sits at the bottom of the pane.

The proof answers every dialog of a turn. It stops when the turn of the scenario ends or after 60 seconds. The limit is 60 seconds because a turn can hold two dialogs. The proof never answers the same dialog twice. After an answer it waits until the text of that dialog is gone or until three seconds pass. The proof records the observation `tui.approval-answered` with the kind of the dialog and the text of the pane.

The scenarios `observe`, `background` and `resume` answer their dialogs. Each of them attaches a real TUI, waits for its first screen, and then answers the dialogs of its turn. The scenario `resume` attaches a TUI to its second server too.

The scenario `approval` does not answer. It has a TUI, and the TUI keeps the answer of the person. That scenario proves that the request of the approval reaches the observer.

The scenario `queue` keeps its behaviour too. It did not ask for an answer.

The app server does not pass its own environment to a stdio MCP server. The report server reads the variables `WEZTERM_PROOF_URL`, `WEZTERM_PROOF_TOKEN` and `WEZTERM_PROOF_RUN_ID` from the environment. The report server found no variable, so the tool call `wezterm_worker_report` failed with `Mcp error: -32000: The proof listener did not record the report.`

The option `env_vars` passes the named variables of the app server to the MCP server. The option `env` sets the values directly. The proof uses `env_vars`, because `env` puts the token value into the command line of the process. Every process of the user can read that line.

The proof of the Codex backend stays open.

The version that `codex` resolves on this machine is 0.142.0. The plan observed 0.157.1. A node `spawn` of `codex` reaches a different binary than `cmd /c codex`, so the probe must resolve the binary before it plans around a protocol version.

The run of 2026-10-29 with all nine scenarios showed that the scenarios shared one list of observations. The runner made one array and gave it to every scenario. A scenario read that array to decide its verdict, so a scenario that ran later read the report of an earlier scenario. The run gave the wrong verdict in three places.

| Scenario | Verdict of the run | The verdict of its own evidence |
| :- | :- | :- |
| `no-report` | fail, a report arrived although none was requested | The scenario holds no report. The report came from the scenario `observe`. |
| `background` | pass, report recorded | The scenario holds no report. The report came from the scenario `observe`. The pass was wrong. |
| `resume` | fail, the first turn produced no report | The scenario holds two reports of its own. The first report of the run was the report of the scenario `observe`. |

Each scenario has its own list of observations now. The runner makes a new list for each scenario, and a verdict reads only the list of its own scenario. The file `observations.jsonl` stays one file for the whole run, and each line keeps its field `scenario`. The scenario `resume` reads its first report from the reports that the first server of the scenario recorded.

A second defect of that run touched the cleanup and the evidence. The stop of a scenario closed the pane of the TUI and left the pane of the app server open. The scenarios `observe`, `queue`, `approval` and `stop` wrote the pane of the TUI into the field of the pane of the server. The run left 4 panes and 9 `codex.exe` processes on the machine. The handle of a scenario keeps two fields now. The field `serverPaneId` holds the pane of the app server, and the field `tuiPaneId` holds the pane of the TUI. A scenario sets the field `tuiPaneId`. The stop of a scenario closes both panes. It ends the process of the server with the command `taskkill /PID <pid> /T /F`, so the child `codex-code-mode-host.exe` ends too. The proof reads the name of the process before it ends it. A pid that the system reused for another program stays alive.

The scenarios `settings-usage` and `recovery` wrote no line of evidence in that run. The scenario `settings-usage` records the messages of its client now. The scenario `recovery` records the messages of the client that it makes after the reconnect. A scenario that records no line of its own does not pass. Its verdict is `fail` and its detail names the missing evidence.

### The second full run

The second full run of the proof ran on 2026-10-29. Its evidence sits in `C:\tmp\codex-proof-all-2`. The verdicts of that run:

| Scenario | Verdict | Detail |
| :- | :- | :- |
| `observe` | pass | turns started: 1, completed: 1, report: recorded |
| `queue` | pass | one accepted entry became a delivered input |
| `no-report` | pass | one native turn ended and no report arrived |
| `resume` | fail | the first turn produced no report |
| `settings-usage` | pass | the native usage endpoint answered |
| `approval` | pass | one native approval request reached the observer |
| `background` | fail | report: missing; background terminal observations: 0; background file: false |
| `recovery` | pass | the observer reconnected to the same server |
| `stop` | pass | one interrupted turn; the unrelated panes survived |

Two scenarios failed for one reason. Nobody answered the approval dialog of the real Codex TUI. The scenario `background` stopped at the request of the approval of a shell command. The scenario `resume` stopped at the dialog of the call of the report server. The proof answered the dialog of the report server once, and Codex asked again.

The run left one pane and two `codex` processes on the machine. The scenario `resume` starts two app servers. Its first server ended in the middle of the scenario, and its early returns skipped the stop of that server. The stop of a server ends its process and its child process, so the two processes of that server stayed too. The scenario stops every server on every path now, including the early returns and a thrown error.

The proof of the Codex backend stays open. The next run of the proof shows which scenarios pass with the own list of each scenario.

Ticket 1 stays open. Tickets 2 to 5 stay blocked for the Codex half of the feature.

### The defect of the fixed path of Codex

The proof looked for the Codex program at one fixed path. That path starts with `C:/Program Files/nodejs`. The path does not exist on this machine.

The proof then started the program `cmd.exe` with the arguments `app-server`. The command never started `codex.exe`. Every scenario failed with the detail `the scenario wrote no evidence`.

The real program sits in the folder of npm. The command `where codex` prints the path of `codex.cmd` in that folder. The proof now reads that output and builds the paths of the program from it.

The old fixed path stays a candidate. The proof checks every candidate with the argument `--version`. The first candidate that runs gives the program and its version. The proof records the path and the version in `versions.json`.

The proof returns null when no candidate runs. The runner then reports the backend as `unavailable`. The proof never starts a shell as the Codex program.

The search of the path is the function `codexBinaryCandidates`. It takes the output of `where codex` and the root of the npm folder. It returns a list of candidate paths. A test checks the function without a pane.

### The scenario background of the Codex proof

The scenario `background` proves the difference between the return of the foreground tool and the later settlement of a background task. The model starts a detached background process that waits 60 seconds, calls the report tool, and ends its turn. The text tells the model not to wait for the process. The proof polls the file of the process while the turn runs, so it can see the file at the right time. The file comes after the report only when the task really ran in the background.

The scenario records four facts as observations. The source `background.command-completed` holds the time of the first `codex.item/completed` of type `commandExecution`. The source `background.report` holds the time of the first report of the scenario. The source `background.turn-completed` holds the time of the first `codex.turn/completed`. The source `background.file-seen` holds the time of the last write of the file and its content. The source `background.file-missing` replaces it when the file never came. The times of the Codex events are the field `at` of the observations of the scenario.

The time of the file is its time of last write, from the stat of the file. It is not the time of the read. The fourth full run showed why. The poll started after the turn, and its first read already found the file. The proof used the time of that read, so a file that the process wrote 8 seconds before the report looked like a file that came after it. The scenario passed, and the pass was wrong. The time of last write shows the real order.

The verdict is a pure function of those facts. It passes only when a command completed, a report arrived, and the file came with the content `BG-DONE` after the report. It fails when the file came before the report, because the turn then waited for the task. It fails when the file never came, because the background task did not settle in the wait. It fails when no report arrived.

The task text names the absolute path of the file in the fixture. The third full run named a relative path, and the file did not show.

The scenario with these changes did not run yet. The next run of the proof shows its verdict.

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
