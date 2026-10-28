# Native backend workers

Status: accepted design. The Claude Code backend is implemented. The Codex backend is not.

## Scope

This decision replaces the OMP-only restriction of ADR 0009. It keeps every evidence and recovery guarantee of ADR 0009.

A worker runs in the CLI that the user selected. The backends are OMP, Claude Code CLI, and Codex CLI. A spawn that names no backend runs OMP. A run that the database holds without a backend field is an OMP run. The migration never guesses a different backend.

The extension never falls back to another backend. A backend that is not implemented is refused, because a silent fallback would run a different program than the user asked for.

A worker exposes the real interactive interface of its CLI. The extension never imitates a native interface with streamed text.

The release stays specific to the backends that are implemented. It adds no daemon, no routine watcher, and no second supervision convention.

## The native bridge

A native worker needs a way to report its task state and to receive a steering instruction. A native CLI has no such interface of its own, so the extension supplies one.

A Claude Code worker loads a session-scoped mod. The mod registers a report tool and polls the owner for commands. The mod imports no Node module. The mod never approves a tool and never refuses a native denial. Every observer passes its event on unchanged.

The mod lives in the session directory of the worker. Two workers never share one plugin directory. The interactive load writes the build-specific types into that copy, so the mod follows the installed build and not the published documentation.

The owner talks to the mod over a loopback HTTP server. The server binds only to 127.0.0.1 and requires a per-run bearer token. The token reaches the worker through the environment of the launch. The token never appears in a command argument and never enters a committed file.

The address and the token of the bridge also live in a handover file inside the session directory. The mod reads that file on every poll. A new owner writes the file again, so a worker that keeps running after a release finds its new owner. A released owner closes its bridge and removes the file, so the released owner accepts no more commands. A run that ends removes the file too, so the worker stops for good.

The bridge holds the observations of one run and the commands of the owner. The bridge is a transport. The decisions that use it live in the library.

## Task evidence

Every rule of ADR 0009 about task evidence applies to a native worker.

A report is the only evidence that proves a task state. Ordinary answer text proves nothing. A native end-of-turn event proves nothing.

A report binds to its run and to its instruction cycle. A report of an earlier cycle cannot finish newer work. A backend that cannot name its cycle sends no cycle, and the supervisor accepts its report only when the run holds one cycle.

The instruction cycle of a native worker is the native turn. A cycle starts at the accepted task instruction or at a steering input. It ends at the native turn boundary when no foreground call of the turn is open.

A native worker reports the state of its task through its own report tool. The tool accepts the same fields as the OMP report tool: `state`, `result`, `dependency`, `resumeCondition`, `needs`, and `detail`. A state-specific field stays required. A completed report needs the result. A waiting report needs the dependency and the condition that resumes the work. A needs input report needs the decision or information that the worker needs.

A child loop of a native worker cannot complete the main task. The report of the main loop settles the task.

## Accepted input and delivered input

The receipt of a command is not an accepted input. The native acceptance of the instruction adds its instruction id to the pending input. The native delivery of the instruction starts its cycle.

An accepted input blocks the completion of the run until the instruction is processed and the latest instruction cycle holds a valid completion report.

A steering instruction never interrupts a running tool. The native prompt API queues the instruction.

A steering instruction is refused while a verified permission request is open. A refused instruction is not saved for a later submission.

A direct task input inside an active pane joins the same run and starts an instruction cycle. The native ingress and the native delivery of that input are separate pieces of evidence.

## Approvals

A native permission request is a fact that the owner must know. The request is raised as an event that keeps the identity of the run. The person answers the request in the pane. The extension never answers a request on behalf of the person.

The modern permission path of Claude Code does not raise the classic permission hook. The permission decision of the tool check is the native request evidence. The resolution is the settlement of the same call.

Pane text is a diagnostic view. It never proves that a request exists or that it was resolved.

## Native configuration

A native worker keeps the configuration, the credentials, the MCP servers and the permission rules of the user. The extension never edits a global setting and never changes a native home directory to control storage.

An omitted model uses the default of the selected CLI. An explicit model identifier is passed through unchanged. The OMP model default stays OMP-specific.

The `tools` parameter is OMP-only. A spawn that names a Claude Code or a Codex worker and gives a tool list is refused before the launch.

## Usage and history

The native usage fields of a worker are the measured fields that the native turn reports. A field that the native program does not report stays missing. The extension never manufactures a zero and never sums a cumulative usage twice.

The native CLI reports the usage of a turn when the turn ends. A run therefore waits for the end of the turn of its cycle before it ends. A run that ends before its turn ends loses the measured usage, because the bridge closes with the run.

The measured usage and the cycle count of a run stay on the job. A finished run keeps them, so the status tool and the delivery still show the counts of the run. A resumed run starts without them, because the usage belongs to the run that measured it.

A native worker writes no OMP transcript. Its activity comes from the native observations. The idle deadline therefore never stops a native worker that is still working.

A resume preserves the backend and the native session history. A resume reuses the native session id of its source run, so the worker comes back with its history. A backend change needs a new worker and a new task.

A run keeps its native history outside the plugin-owned state. The cleanup never removes it.

## Events of a native run

An event of a native run keeps the identity of the run. The status tool lists the events that wait for the owner, with their event ids. The owner acknowledges each event with its id. An event that nobody handled blocks the cleanup.

A native worker is found in the process table by the path of its plugin, because the path names the session directory of the run. A recovery therefore finds a native worker after a crash of the owner, the same way it finds an OMP worker.

## Execution evidence

A native worker keeps the execution ledger of ADR 0009. A native call opens a row at the observation `tool.call.opened`. The row settles at the observation `tool.call.settled` or at the observation `tool.call.failed`. The bridge carries this evidence, because a native worker writes no OMP transcript.

A call to the report tool opens no row. The report file is its own evidence.

A background task of a native worker settles in its own right. The settlement of a background task and the return of the foreground tool are separate pieces of evidence.

The mod forwards the flag of a background call. It forwards the id of the task that the call started. It forwards the id of the call and the status of the notification of a task. The ids and the status are read from the text of the notification, because the host writes them there. The text is a host format and not a documented field, so a new build of the host can change it. A text without the tags gives null, and the mod never throws.

The supervisor opens a row of kind background for such a call. The return of the call leaves the row open, because the task of the call still runs. A failed call settles its row, because a call that failed started no task.

A notification settles the row of its call. The supervisor settles the row for every status that the notification carries, including a failure. The status names the settlement evidence.

A stop of a task settles the row of that task. The tool `TaskStop` names the task in the text of its result. The mod keeps the call that started each task, so the stop names that call too. The supervisor settles the row by the id of the task.

A row that the supervisor cannot link stays open. A notification without a call id and a notification without a status leave the row open. A stop of an unknown task changes nothing. An open row blocks a completion report, because the supervisor cannot prove that the task ended.

The probe of 2026-10-28 did not cover a task that the user stops with a key in the pane. It did not cover a stop with another tool. It did not cover a task that still runs when the worker ends. It did not cover a status other than `completed` and `failed`. The supervisor keeps the row open in each of these cases, because the data that links the task is missing.

A known outstanding execution blocks a completion report. An unknown execution blocks it too, because the supervisor cannot prove that the work finished.

The rows of a native run survive a restart of the owner, because the ledger lives in the database. After a restart the owner starts a new bridge for the run, writes the handover file again and watches the worker. The worker follows the new bridge through the handover file. The worker sends a run snapshot to the new owner. The new owner settles the open rows of kind tool that the snapshot does not hold, because the worker names the calls that still run. The rows of kind background stay open, because a task settles through its own notification. A stored open row keeps blocking the completion of the run until a settlement arrives or the worker stops. A re-attachment that fails stops the worker, because a worker without a supervisor keeps running. The stop waits for the pane to close, so the ledger of the run closes only after the worker really stopped.

## Recovery and stops

Every rule of ADR 0009 about recovery and stops applies to a native worker.

A stop kills only the pane of the selected worker. The stop is confirmed when the pane list shows the pane gone and the native process of the worker has ended. A missing pane alone is not a confirmed stop.

A controller failure recovers the original execution. The extension never launches a replacement automatically.

A cleanup refuses unhandled events and preserves the dirty work and the external native history.

## Tradeoffs

A session-scoped mod and a loopback bridge add a native dependency. They buy the real native interface, the native permission flow, the native usage and the native history. The alternative, a text protocol that imitates a native interface, loses every one of those.

A native worker does not share the transcript format of an OMP worker. The supervisor therefore reads the native state of a native run instead of the transcript. The decision functions stay pure, so they are still testable without a pane.

The Codex backend needs a different bridge. It talks to a dedicated app server over a websocket. The bridge is a transport, so the second backend reuses the decision functions and the event model.

## What this replaces

This decision replaces the OMP-only restriction of ADR 0009. It keeps the evidence rules, the recovery guarantees, the event model and the ownership rules of ADR 0009.

ADR 0009 stays the source of the task evidence rules, the recovery guarantees and the transactional storage.
