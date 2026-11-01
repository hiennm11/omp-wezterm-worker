# Codex backend workers

Status: accepted design. The owner accepted it on 2026-10-30. The extension has a Codex backend. A spawn that names `codex` starts a Codex worker.

## Context

ADR 0010 lets a worker run in a native CLI. The extension has the Claude Code backend. ADR 0010 says that the Codex backend needs a different bridge, because Codex has no mod inside its process.

The Codex proof in `tooling/backend-proof/` runs all nine scenarios on Windows. The last full run passed on codex-cli 0.166.0. The decisions below come from that evidence. The file `docs/backend-proof-evidence.md` lists the evidence folders of the runs. A decision that the proof did not test says so.

## The app server

Each Codex worker has its own app server. The extension starts `codex app-server --listen ws://127.0.0.1:<port>` in a pane of its own. The port comes from the operating system. The server ends with the worker. The extension never uses the shared daemon of Codex, and it never ends it.

The extension controls the thread through the protocol of the app server. The extension is a client of one thread. A TUI that makes its own thread gives the client no events of that thread. The TUI must thus attach to the thread of the client.

The calls follow a fixed order:

1. `initialize` with the experimental API setting, then `initialized`.
2. `thread/start` with the folder and the model.
3. `thread/name/set`. This call writes the rollout file of the thread.
4. `thread/resume`.
5. The TUI starts in a second pane with `--remote <endpoint> resume <thread>`.
6. `turn/start` with the task.

The rollout file must exist before the TUI starts. The request `thread/start` makes a thread with no rollout file, and the command `resume` of the TUI then ends at once with "no rollout found". The proof found this on 2026-10-29.

The TUI starts through PowerShell with the call operator, because the path of the binary has a space in it. The binary is the one that the extension found by its full path. The bare name `codex` is an npm shim that Node cannot start.

## The report tool

The worker reports through an MCP server that the extension loads. The extension passes the server to the app server with `-c mcp_servers.wezterm_worker_report.command` and `args`. The app server does not pass its own environment to a stdio MCP server. The setting `env_vars` names the variables that the child inherits. The extension uses `env_vars` and never `env`, because `env` puts the token value into the command line of the program.

A report names its run and its instruction cycle, as ADR 0010 says. Ordinary answer text proves nothing. The proof shows that a turn without a report ends with no report.

## Approvals

The TUI keeps the approval of a shell command. The person answers it in the pane. The extension never answers it.

By default, Codex asks for the approval of every call of an MCP tool. The turn then stops until a person answers. The proof showed this: with no setting, one request came, the turn did not complete, and no report arrived.

The setting `-c mcp_servers.<name>.tools.<tool>.approval_mode="approve"` removes the question for one tool. I tested it on codex-cli 0.165.0 with the report tool. The request count fell to zero, the turn completed, and the report arrived. The key `default_tools_approval_mode` does the same for all tools of the server.

The extension sets `approval_mode="approve"` for the report tool only. This is a configuration of the MCP server that the extension itself loads. It is not an answer to a native dialog, so it keeps the rule of ADR 0010: the extension never answers a native dialog. The tool only sends the state of the task to the owner, so the owner loses nothing by the approval. The approval of a shell command stays with the person.

## Evidence and the cycle

A report is the only evidence of a task state. A native end of turn proves nothing. The instruction cycle of a Codex worker is the native turn. The event `turn/started` opens it and the event `turn/completed` closes it. The supervisor reads these events from the app server.

A background task of a Codex worker outlives the turn. The proof showed a background process that wrote its file 57 seconds after the report and 54 seconds after the turn. The foreground return and the end of the background task are separate facts. The supervisor must not read the end of a turn as the end of a task.

The proof does not show these items. The supervisor needs a decision for each one before the backend ships. This ADR does not make these decisions.

- How the report links to the cycle. The report server records the run. The proof did not compare the report with the id of the turn. Issue #87 covers it.
- How a queued instruction blocks an early report. The proof shows that the queue accepts an item and gives it to the worker. It does not show the block. Issue #88 covers it.
- How the supervisor knows that a background task is still open. The proof found no native notification of a background task in a Codex worker. Issue #86 covers it.

## Usage and history

The usage of a turn comes from the event `thread/tokenUsage/updated`. The event holds the total, the input, the cached input, the cache write input, the output and the reasoning output. A field that Codex does not report stays missing. The extension never manufactures a zero. The endpoint `account/usage/read` answers with the usage of the account.

The command `resume` keeps the thread. The second app server opens the same thread id with `thread/resume`. The proof shows that the thread keeps its turn and answers a new report. The command `resume` uses the thread id of the source run. A backend change needs a new worker.

The thread lives in `~/.codex`. The extension never edits it and never removes it.

The app server of Codex writes a trust entry into `~/.codex/config.toml` when the request `thread/start` names a folder that the configuration does not trust yet. The extension never writes that file itself. The write of the app server keeps the settings, the credentials, the projects and the model of the user, so the extension must not prevent it.

## Stops and cleanup

A stop ends the turn through the protocol, and then it ends the program of the app server. The program belongs to the user, so the extension reads the name of the program before it ends it. It ends the program only when the name is `codex.exe`. If another program took the process id, the name differs and that program stays alive. The extension ends the child programs of the server with it, and it closes both panes.

The proof found that a stop that closes only one pane leaves the server and its child programs on the machine. The stop of the extension must close both panes and end the program, on every path, including an early return.

A worker that ends on its own ends its app server too. The end of the run closes both panes and ends the program of the server, so the machine holds nothing of a finished worker. The pane policy of the spawn cannot keep a Codex pane open for inspection, because the TUI needs the server of that pane.

## Scope of the first version

The first version supports spawn, the report, the instruction queue, the native usage, cancel and `resume`.

The spawn function of a Codex worker exists. The function starts the app server in one pane, the TUI in a second pane and the task as the first turn. The spawn tool names the Codex worker when the caller asks for the backend `codex`. The tool refuses a spawn with a tool list and the Codex backend before the launch. A Codex worker uses the tools of its own CLI.

The report channel exists. The extension loads a stdio MCP server into the app server. The server posts every report to the bridge of the run, and the report reaches the run state of the owner. The owner reads the report with the decision functions of the Claude Code backend. The report carries no cycle id, so the supervisor accepts it when the run holds one cycle.

The events of a Codex worker exist. The extension reads the messages of the app server and turns them into the observations of a native run. The reducer and the ledger of a native run then do the rest. A Codex worker fills the same run state as a Claude worker. The usage of a turn is the change of the totals of the thread. The change runs from the last update before the turn to the last update of the turn.

The instruction queue of a Codex worker exists. The owner sends a steering instruction with the request `turn/steer`, and the server joins it to the running turn. An accepted instruction waits for its delivery. The delivery shows in the item of the message that the server sends for it.

The open parts of these two parts are the client of the app server and the stop of a worker. The client stays open after the launch, and the stop slice closes it. A run that ends before its client closes keeps a socket open. The report of a Codex worker also stays open, because the report channel is a separate slice.

The stop of a Codex worker exists. The extension ends the open turn with the request `turn/interrupt`, and it ignores a failure of that request. Then it ends the program of the app server and it closes the pane of the app server and the pane of the TUI. The extension confirms the stop only when no step failed. A failed step leaves the worker running with a pending stop, so the next cancel and the monitor retry the stop. The client of the app server closes with the run, so a run that ends early closes its socket too.

The resume of a Codex worker exists. The extension continues the thread of the source run with the request `thread/resume`. The thread keeps its id and its turns, so the worker comes back with its history. The resume starts no new thread and names no thread. The rollout file of the source run already exists. The TUI of the resumed run starts with the command `resume` and the thread id of the source run.

The extension starts a turn only when the owner gave an instruction. A resume without an instruction opens the thread and starts no turn. The new run has a new run id, a new bridge and a new report channel. The report of the source run cannot finish it.

A resume refuses to start while the pane of the TUI of the source run is open. It also refuses to start while the pane of the app server is open. It refuses to start when the machine cannot list the panes. A failed resume ends the program of the app server and closes both panes.

The recovery of a Codex worker after a restart of OMP exists. The new session finds the app server through the identity of the job in the registry, so the extension never scans the machine. The extension proves the identity with three checks. A process with the id of the identity must exist. Its name must be `codex.exe`. Its command line must hold `app-server --listen ws://127.0.0.1:<port>` with the port of the identity. A failed check means that the worker is not attached, so the extension stops it as failed and names the check that failed. The extension sets the process id of the identity to null before that stop, so the stop closes the panes and never ends a program that the check did not prove. The same command line check guards the stop of a running worker, so a process id that the system gave to another `codex.exe` of the user stays alive. The new session connects to the app server again and resumes the thread of the worker. The client of the app server then joins the run state, so the owner can steer the worker and stop its open turn. The report server of Codex reads the handover file of the session directory on every post, so the reports of the worker reach the new owner. The usage of a restored run is partial, because the turns before the restart stay unmeasured.

The takeover of a running Codex worker by another session exists. The second session becomes a client through the same function that the recovery uses, so the extension has one path to the app server of a worker. The takeover runs the same identity check with the same three checks, so a worker that fails the check stops as `failed` and the extension ends no program that the check did not prove. The second session starts a new bridge and writes the handover file again. The report server of Codex reads the handover file on every post, so the reports of the worker reach the second session. The worker keeps its id, and the takeover starts no second app server and no second worker. The proof of 2026-11-01 shows that the app server of Codex accepts a second client while the first client is open, and that a second client can resume the thread of the first client.

The release of a Codex worker closes the client of the app server and removes the run state of the worker. A closed client delivers no message to its handler, so the first session receives no observation of the worker after the release. The release never stops the worker, never ends the app server and never closes a pane.

The report of a Codex worker reaches the owner through the bridge of the run. The bridge closes when the owner releases the task, and the next owner starts a new bridge. The report file of the session directory is the durable channel. The report server of Codex writes every report to that file before it posts to the bridge. A report that arrives while no owner holds the task is therefore not lost, and the new owner reads the file when it builds the run state of the worker.

A released task waits for the takeover tool. The startup of a session does not take the task of a released worker, because the takeover tool is the way that the owner gives a task away.

The first version does not support these items. Each one has its own issue. The owner accepted these gaps on 2026-11-01, so the first version ships with them.

- A platform other than Windows. Issue #85 covers it.
- A background task that the supervisor monitors as an execution record. Issue #86 covers it.

The spec of the feature says that a known background task blocks the completion. The Codex backend does not meet this sentence in the first version. The owner named this exception on 2026-11-01, and the spec carries the same exception. The exception covers the background task only. No other item of the spec has one.

A criterion of this backend closes with a smoke or with a test of the behavior. A proof of the protocol shows what Codex does, and it never closes a criterion alone. The smoke runs on demand with `npm run smoke:codex`, and not as a part of `npm run check`, because it needs the login of the user and it calls a real model. A failed smoke blocks the criterion, and no criterion of the first version ships with a reduced mode.

A report binds to its cycle with the turn id. The call of an MCP tool carries the turn id in `params._meta["x-codex-turn-metadata"].turn_id`. The probe of 2026-11-01 showed it on codex-cli 0.166.0 through the app server, and the turn id changes between two turns of one thread. The report server sends that id as the cycle of the report. A report with no turn id never ends a worker. The supervisor raises an event for the owner instead. The older rule of ADR 0010, that a report with no cycle counts while the run holds one cycle, does not hold after a takeover, because the new owner restores only the open turn.

## Reuse of the Claude Code backend

The decision functions stay as they are. They are pure, and they read the run state and the events. The first version uses the completion rule, the report decision, the ledger and the event model again.

The Codex backend adds one bridge. The bridge speaks to the app server. It does not share an interface with the Claude Code bridge. The two bridges may share one after both run, and not before. A shared interface that two real bridges do not need yet is a guess.

## Tradeoffs

One app server for each worker costs one more program and one more pane for each worker. It buys a clean stop and a TUI that attaches to the thread of the client. A shared daemon would remove the cost, but a stop would then need to avoid ending a program of the user.

The setting `approval_mode="approve"` removes one question for the report tool. A person can no longer refuse a report. The report only states a task state, so the cost is small. The alternative asks the person at every report, and a person who does not answer stops the turn.

The Codex backend depends on a protocol that Codex marks as experimental. A new build of Codex can change a method or a field. The proof records the build, and it runs again on a new build.

## What this keeps

This decision keeps ADR 0010. It keeps the evidence rules, the event model and the rule that the extension never answers a native dialog. It adds the Codex bridge that ADR 0010 announced.
