# Recoverable OMP supervision

Status: accepted design. The runtime does not yet implement this contract.

## Scope

Build the change in separate review steps. Release it only after one complete acceptance gate passes.
Keep the release specific to OMP. Add no daemon, routine LLM watcher, or other CLI adapter.
Guarantee recovery after an OMP process failure. Recovery after a machine shutdown remains best effort.

## Task evidence

A worker reports working, waiting, needs_input, or completed through a dedicated reporting tool.
Missing or invalid reports leave the task state unknown. Ordinary answer text never proves completion.
Bind each report to its current run. An earlier completion cannot finish a resumed run.
A completion report includes the result. It declares worker completion, not owner acceptance.
The worker records evidence. Only the supervision owner changes lifecycle state and delivers events.
Completion requires all task-owned work to finish. The worker must observe background execution results before reporting completion.
Reject completion while known execution evidence remains outstanding.
The supervisor does not claim to discover every detached process.

The run keeps an execution ledger. Each row holds an execution id, start evidence, an observation method, and settlement evidence.
A row opens when the transcript shows a tool call that carries an id.
A row settles when a tool result carries that same id. One result never settles another call.
A row that never settles keeps an unknown state. An unknown row blocks a completion report.
Do not infer settlement from an open pane, from transcript growth, or from an empty tool value.

A waiting report names the external dependency and the condition that resumes work.
The worker must retain a way to observe that condition. The supervisor does not manage external execution.
A worker that disappears while waiting requires intervention. The supervisor does not start another writer.
The unit of the missing report rule is one instruction cycle. It is not one assistant message.
A cycle starts at the accepted task instruction or at a steering input.
A cycle ends at a verified terminal assistant boundary with no open foreground call.
A cycle must hold at its terminal boundary for a settling time before the rule applies.
A partial transcript or an open tool call does not close a cycle.
The event key joins the run id, the evidence id of the cycle start, and the condition kind.
A report inside the cycle satisfies the report rule. Later ordinary text does not remove that report.
A working report followed by a verified idle execution is a separate condition. It creates its own event.
A later valid report can resolve an obsolete event. The history of that event stays.
Transcript silence alone remains status information. It does not stop a worker or repeatedly wake the main agent.
A working report does not hide an execution gap.
If the worker ends its cycle without active execution or an observable external wait, create one intervention event.
Do not automatically send a continue instruction.

Remove automatic stopping based on transcript inactivity.
Reject a nonzero legacy idleTimeoutMs setting with migration guidance instead of silently changing its meaning.
Keep the total execution deadline.

## Recovery and stops

Inspect the saved state and transcript before declaring failure when a pane disappears.
Preserve legacy workers without completion signals as unknown. Require an owner decision before declaring success.
Keep historical results from the old completion rule as legacy and unverified.
Do not replay historical records as new work or silently promote them to explicit completion.
Recover valid completion evidence before stopping unfinished work after an expired deadline.
A completion after the deadline can be recovered if no stop intent exists.
The supervisor cannot enforce an execution deadline while OMP is absent. Report that limit.

Each launch attempt holds a reservation with one of five states: reserved, issued, attached, unused, or unresolved.
The reserved state means that the row exists and that no command has run yet.
The issued state means that the command was sent and that the pane may or may not exist.
The attached state means that the pane id and the worker identity are both known.
The unused state means that the command failed before any worker started.
The unresolved state means that a crash left the attempt without a receipt.
Persist the reserved state before the command runs. Persist the issued state before the command runs.
After a crash, find the live worker by the process command line, the session file header id, and the pane id.
A matched worker becomes attached. No match is not proof that no worker exists.
An unresolved attempt keeps its capacity and creates one intervention event. Never send the command again.
Only a confirmed unused attempt or an explicit owner resolution frees an uncertain reservation.

A completion committed before cancellation remains completed.
A durable stop intent wins over later completion reports. Preserve a later answer as evidence.
Confirm the stop before assigning its final status.
If execution disappears without completion or a stop intent, record execution loss and keep the task outcome unknown.
Create one intervention event. Never restart automatically.

Each launch and each resume belongs to a resource group. The group names the shared transcript directory and the isolated worktree.
A resume reserves execution for the group before it reads the baseline and before it starts a pane.
Refuse a resume when another run in that group holds a reservation, a live execution, a stopping execution, or an unknown execution.
Refuse a resume when the previous pane is still present or when its health is unknown.
A run that declared completion does not free the group while its pane lives.
The owner can still read a completed pane before the owner closes it.
Mark the group disposing only when no run holds an execution reservation and no linked event is unhandled.
A disposing group refuses every resume and every launch against it. Keep the marker until the deletion finishes.

## Events and handling

Persist the result and its pending event in the same state update.
Each event keeps one ID through replay. Deliver at least once and make repeated handling safe.
A successful message injection does not prove handling.
The main session acknowledges the event ID with a recorded disposition after handling it.
Follow-up work can continue after that acknowledgement. Reading the result alone does not acknowledge the event.
An acknowledged event does not wake the owner again.

Attempt automatic delivery once per owner activation. Replay an unacknowledged event after recovery or takeover.
Permit explicit retry. Normal observation polls do not resend a pending event.
Resolve an obsolete input request only when recorded evidence proves its condition no longer applies.
Keep the event history. Deliver a later completion as a separate event.
Do not discard unresolved results.
Block cleanup while a result or another actionable event remains unhandled.
The owner can record an explicit discard disposition before cleanup.
The cleanup force option applies only to worktree changes. It cannot discard pending handling.

The owner resolves an unknown task outcome through a separate operation.
It takes the worker id, the event id, the resolution, and an evidence note.
The resolution is one of three values: recorded_result, incomplete, or abandoned.
The recorded_result value needs a saved result and an evidence note. It records an owner outcome.
The recorded_result value never writes an explicit worker completion report.
The incomplete value keeps the unknown task evidence. It allows a resume only after the resource exclusion succeeds.
The abandoned value closes the owner obligation. It keeps the transcript and the worktree.
The abandoned value allows no second writer while an execution is live or unknown.
The operation needs the current ownership and an actionable unresolved event.
An identical repeated resolution succeeds without another effect. A conflicting repeat is refused.
The resolution and the event disposition are written in one transaction.
An evidence note alone cannot stop a live or unknown process. The process and pane evidence decides that.
Use this operation for legacy tasks and for ambiguous launch interventions.

Each delivery attempt keeps the event identity and the owner generation.
An attempt that settled and an attempt of uncertain outcome stay distinct from a handling acknowledgement.

## Ownership

Ownership is exclusive per task. Different main sessions can supervise different tasks concurrently.
Coordinate shared storage writes so one session cannot overwrite another session's records.
Ownership acquisition must be atomic. Every lifecycle write and delivery requires current authority.

The original main session can recover automatically after its previous process exits.
A different main session must request takeover explicitly.
Permit takeover only after the previous owner releases authority or its process is confirmed gone.
A stale heartbeat does not prove that the owner exited.
An unresponsive owner that remains alive requires manual intervention.
A surviving worker does not prevent recovery after its supervisor exits.
If two live processes open the same main session, the first owner retains authority.
The second process can inspect records but cannot control those tasks or replay their events.
Apply the active worker limit across the shared state directory. Reserve launches atomically.
Keep the per-request launch limit local to its main session.

The ownership row holds a phase: active, releasing, or released.
An operation gate in the owner scope serializes the start of an external action and the move into the releasing phase.
The release moves the phase to releasing in one transaction. It refuses new external actions after that.
The release waits for the actions that already started. It commits the released phase only after they finish.
A wait that times out leaves the phase releasing. The release returns the action that did not settle and keeps the authority.
A generation number cannot fence an action that already started. Do not claim that it can.
Persist a stop intent before sending a destructive pane command. A recovered owner reconciles it before it steers, resumes, or cleans up.
A command that ran before a crash cannot be taken back. The reconciliation reads the pane state.

## Transactional storage

Use SQLite through node:sqlite for lifecycle records, ownership, launch reservations, and pending events.
Use transactions instead of whole-registry replacement. Keep ownership checks and writes in the same transaction.
Require runtime support and fail clearly when it is absent. Never fall back to writable JSON storage.
Import the old registry once and preserve it as migration evidence.
The extension never writes the old registry file again. Two processes cannot lose one another's records.
Do not support concurrent writes from an older plugin version after migration.
The built-in SQLite API is experimental in Node 22.19.0. This release accepts that runtime constraint.

## Host runtime facts

The OMP host runs the Bun runtime. Bun implements the module `node:sqlite` in full.
A live OMP session opened a database through `node:sqlite`, wrote a row, and read it back.
The host exposes a stable session identity. The session header holds the field `id`, and a session keeps it across a move.
Use that field for ownership. Do not use the session file path for that purpose.
A tool call and its result share an id. A `toolCall` block holds `id`, and a `toolResult` message holds `toolCallId`.
The tool result details persist in the transcript. Use them as settlement evidence.
The background work of the `job` tool reports its job id and status in the tool result details.
The command line reference states that plugin capabilities still load when the built-in capabilities are restricted.
The worker session directory names the job, so the launch context binds the report to its run.
The launch sets the variable `OMP_WORKER_SESSION_DIR` for the worker process.
The WezTerm pane inherits the environment of the process that started it, so the variable reaches the worker.
The worker bootstrap reads the run context from that directory and gives the worker only the report tool.
The launch appends a system prompt that states the reporting contract.
A worker that does not report leaves the task state unknown. The prompt is the only way to reach it.
The report file of a run carries the run id. A resumed run does not read the reports of its source run.


## Tradeoffs

Explicit reports replace text-only completion detection because a completed turn does not prove a completed task.
Explicit acknowledgement replaces receipt-based handling because a saved or delivered result can remain unhandled.
Refusing live-owner displacement limits automatic recovery but avoids concurrent supervision after a suspected stall.
At-least-once replay can repeat delivery after a crash. It cannot guarantee exactly-once external actions.
Owner resolution keeps the worker completion rule clean. The owner decides an unknown outcome without forging a report.
A resource group costs a shared identifier on each run. It removes a race between a resume and a cleanup.
An unresolved launch keeps its capacity. A lost worker holds a slot until the owner resolves it.
The release drain waits for the actions that already started. A stuck action keeps the authority with the current owner.

This decision replaces the text-only completion rule described in ADR 0001.
The transcript remains the evidence source. Pane text remains a diagnostic view.
