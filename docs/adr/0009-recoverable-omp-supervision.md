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

A completion report includes the result. It declares worker completion. It does not declare owner acceptance.

The worker records evidence. Only the supervision owner changes lifecycle state and delivers events.

Completion needs all task-owned work to finish. The worker must observe background execution results before reporting completion.

Do not accept a completion while the known evidence of an execution remains outstanding.

The supervisor does not claim to find every detached process.

The run keeps an execution ledger. Each row holds four values: an id of the execution, the start evidence, the method of observation, and the evidence of the settlement.

A row opens when the transcript shows a tool call that carries an id.

A row settles when a tool result carries that same id. One result never settles another call.

A call that starts a background job settles in two cases. The first case is an `async-result` entry that names its job id.

The second case is a result of the tool `wait` that names its job id. The job status must be `completed`, `failed` or `cancelled`.

A row that never settles keeps an unknown state. An unknown row blocks a completion report.

Do not infer settlement from an open pane, from transcript growth, or from an empty tool value.

A waiting report names the external dependency and the condition that resumes work.

The worker must retain a way to observe that condition. The supervisor does not manage external execution.

A worker that vanishes while waiting needs intervention. The supervisor does not start another writer.

The unit of the missing report rule is one instruction cycle. It is not one assistant message.

A cycle starts at the accepted task instruction or at a steering input.

A cycle ends at a verified terminal assistant boundary with no open foreground call.

A cycle must hold at its terminal boundary for a settling time before the rule applies.

A partial transcript or an open tool call does not close a cycle.

The event key holds three values: the run id, the evidence id of the cycle start, and the condition kind.

A report inside the cycle satisfies the report rule. Later ordinary text does not remove that report.

A working report followed by a verified idle execution is a separate condition. It creates its own event.

A later valid report can resolve an obsolete event. The history of that event stays.

The transcript with no new text alone remains status information. It does not stop a worker. It does not wake the main agent again and again.

A working report does not hide an execution gap.

If the worker ends its cycle without active execution or an observable external wait, create one intervention event.

Do not send a continue instruction automatically.

Remove automatic stopping based on transcript inactivity.

Reject a nonzero legacy idleTimeoutMs setting. Give the owner guidance for the migration. Do not change the meaning of that setting silently.

Keep the total execution deadline.

## Recovery and stops

Examine the saved state and the transcript before you declare a failure. Do that when a pane vanishes.

Keep legacy workers without completion signals as unknown. The owner must decide before you declare success.

Keep historical results from the old completion rule as legacy and unverified.

Do not replay historical records as new work or silently promote them to explicit completion.

A restart can drop the result of a finished run. The startup recovery sends that result again.

The recovery sends only the results that this session owns. It sends only the results that never reached the main session.

A cancelled run has no delivery row. The recovery skips it.

The first recovery writes the mark `delivery_replay_since`. Later recoveries send only the runs that ended at or after that time.

Recover the valid evidence of a completion before you stop unfinished work. Do that after an expired deadline.

The supervisor can recover a completion after the deadline. That recovery needs no stop intent.

The supervisor cannot enforce an execution deadline while OMP is absent. Report that limit.

Each launch attempt holds a reservation with one of five states: reserved, issued, attached, unused, or unresolved.

The reserved state means that the row exists. It also means that no command ran yet.

The issued state means that the host sent the command. The pane may or may not exist.

The attached state means that the pane id and the worker identity are both known.

The unused state means that the command failed before any worker started.

The unresolved state means that a crash left the attempt without a receipt.

Persist the reserved state before the command runs. Persist the issued state before the command runs.

After a crash, find the live worker. Use the process command line, the session file header id, and the pane id.

A worker with a match becomes attached. No match is not proof that no worker exists.

An unresolved attempt keeps its capacity. It creates one intervention event. Never send the command again.

Only a confirmed unused attempt or an explicit owner resolution frees an uncertain reservation.

A completion committed before cancellation remains completed.

A durable stop intent wins over later completion reports. Keep a later answer as evidence.

Confirm the stop before you give it its final status.

If the execution vanishes without a completion or a stop intent, record execution loss. Keep the task outcome unknown.

Create one intervention event. Never restart by itself.

Each launch and each resume belongs to a resource group. The group names the shared transcript directory and the isolated worktree.

A run finds its group through its session directory. A resume of a resumed run takes the group of the first run of the task.

A resume reserves execution for the group. It does that before it reads the baseline. It also does that before it starts a pane.

Refuse a resume when another run in that group holds a reservation.

Refuse a resume when the previous pane is still present. Refuse it too when the pane health is unknown.

No production code sets the execution states `stopping` and `unknown` today (issue 26). They stay in the schema.

A run that declared completion does not free the group while its pane lives.

The owner can still read a completed pane before the owner closes it.

A run frees the group when the run ends and its pane is gone.

The startup recovery frees a group whose holder ended and whose pane is gone.

A resume and a cleanup free a group whose holder ended and whose pane is gone.

The pane list proves that the pane is gone. An unreadable pane list keeps the group held.

Mark the group disposing only when no run holds an execution reservation. Do it only when no linked event is unhandled.

A disposing group refuses every resume and every launch against it. Keep the marker until the deletion finishes.

## Events and handling

Persist the result and its pending event in the same state update.

Each event keeps one ID through replay. Deliver at least once and make repeated handling safe.

A correct message put does not prove handling.

The main session acknowledges the event ID with a recorded disposition after handling it.

Follow-up work can continue after that acknowledgement. Reading the result alone does not acknowledge the event.

An acknowledged event does not wake the owner again.

Attempt automatic delivery once per owner activation. Replay an unacknowledged event after recovery or takeover.

The startup recovery replays a finished run whose result never reached the main session.

The replay uses the same delivery as the first attempt. It keeps the event identity that way.

A delivery that fails does not stop the replay of the next run.

Let an operator retry. Normal observation polls do not resend a pending event.

Resolve an obsolete input request only when recorded evidence proves that its condition no longer applies.

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

The incomplete value keeps the unknown task evidence. It lets a resume start only after the resource exclusion succeeds.

The abandoned value closes the owner obligation. It keeps the transcript and the worktree.

The abandoned value lets no second writer work while an execution is live or unknown.

The operation needs the current ownership and an actionable unresolved event.

The same repeated resolution succeeds without another effect. The code refuses a conflicting repeat.

The code writes the resolution and the event disposition in one transaction.

An evidence note alone cannot stop a live or unknown process. The process and pane evidence decides that.

Use this operation for legacy tasks and for ambiguous launch interventions.

Each delivery attempt keeps the event identity and the owner generation.

An attempt that settled and an attempt of uncertain outcome stay distinct from a handling acknowledgement.

## Ownership

Ownership is exclusive per task. Different main sessions can supervise different tasks concurrently.

Coordinate shared storage writes. Make sure that one session cannot overwrite another session's records.

Take ownership atomically. Every lifecycle write and delivery needs current authority.

The original main session can recover automatically after its previous process exits.

A different main session must request takeover explicitly.

Let a takeover happen only after the previous owner releases authority. Let it happen only after the code confirms that the owner process is gone.

A stale heartbeat does not prove that the owner exited.

An unresponsive owner that remains alive needs manual intervention.

A surviving worker does not prevent recovery after its supervisor exits.

If two live processes open the same main session, the first owner retains authority.

The second process can inspect records but cannot control those tasks or replay their events.

Apply the active worker limit across the shared state directory. Reserve launches atomically.

Keep the per-request launch limit local to its main session.

The ownership row holds a phase: active, releasing, or released.

An operation gate in the owner scope serializes the start of an external action. It also serializes the move into the releasing phase.

The release moves the phase to releasing in one transaction. It refuses new external actions after that.

The release waits for the actions that already started. It commits the released phase only after they finish.

A wait that times out leaves the phase releasing. The release returns the action that did not settle. It keeps the authority.

The generation of the owner cannot fence an action that already started. Do not claim that it can.

Persist a stop intent before sending a destructive pane command. A recovered owner reconciles it when the session starts. It does that before it steers, resumes, or cleans up.

A command that ran before a crash cannot go back. The reconciliation reads the pane state.

The reconciliation handles the intents of the runs that the session owns.

It confirms an intent whose pane is gone. It fails an intent whose pane still exists.

An unreadable pane list keeps the intent pending. The code never guesses.

A pending intent refuses the tools steer, resume, and cleanup.

The tool cancel stays open. It retries the stop.

### Monitor authority

Every poll of a monitor reads the ownership row of its task.

The monitor of a session that released the task stops. The monitor of a session that lost the task to another session stops too.

Such a monitor ends no worker. It writes no ledger row and delivers nothing.

The phase releasing is temporary. The release can fail and give the task back to the owner.

A monitor in the phase releasing waits. It does not stop the worker.

A task without an owner and a session without an identity keep the old behaviour.

The end of a monitor runs as a counted action. The stop of a monitor runs as a counted action too.

A counted action appears in the list of the actions that did not settle yet.

The release waits for that list. So the release cannot move the authority while a monitor still writes the lifecycle.

A session writes the row of a run only when it holds the authority of the task of that run.

A session that does not hold the authority keeps a stale copy of the run. Its write changes no row.

The check and the write of a run run in one transaction. So a session that lost the task writes nothing.

A run without an ownership row gets its first row. A session without an identity writes as it did before.

Each action reads the ownership row again when it starts. The check of the tick is not enough.

An action whose verdict is not act writes nothing. It tells nothing. The next tick decides again.

A finished run never returns to an active status in the database.

The guard sits in the write of the runs. A stale copy of a run cannot revive a finished run.

The other fields of a finished run still change. A closed pane and a new result stay readable.

The function attachWorker runs right after the acquisition of the task. So it needs no check.

The function releaseEndedGroups frees a group only from facts that every session can read. So it needs no check.

A probe of the function reconcileAttempts shows that a new session marks the open launch attempt of another session as unresolved.

The probe does not fix the behaviour. The fix needs its own design.

The new owner attaches the worker at its own session start.

### Takeover

The tool `wezterm_worker_takeover` moves the supervision of one worker to another main session.

The tool writes one ownership row and sends no command to a pane.

The tool lets the takeover happen in three cases. The first case is a task of another session in the phase released.

The second case is a task of another session. The code confirms that the owner process of that session is gone.

The third case is a task of another session. Another process took the id of the owner process.

The tool refuses a takeover when the owner process still runs.

The tool refuses a takeover when the code cannot read the process table.

The tool lets a takeover of a native worker happen. The new owner starts a new bridge for the run. The new owner monitors the worker.

The tool refuses a takeover when the session cannot read the start time of its own process.

The phase releasing is not special. A dead owner can leave that phase.

The check of the owner process runs outside the transaction.

The write thus compares the generation that the check read.

The write refuses the takeover when the generation moved in the meantime.

The write moves the generation forward by one and sets the phase to active.

A takeover of a finished worker moves the ownership and starts no monitor.

The finished worker keeps its status, its result and its error.

The new owner holds the authority for the pending events of that worker.

A takeover does not replay the pending events of the worker.

The main session reads the pending events with the status tool.

The replay of a pending event after a takeover is a separate change.

## Transactional storage

Use SQLite through node:sqlite for lifecycle records, ownership, launch reservations, and pending events.

Use transactions instead of whole-registry replacement. Keep ownership checks and writes in the same transaction.

Runtime support is necessary. Fail clearly when it is absent. Never fall back to writable JSON storage.

Import the old registry once. Keep it as the migration evidence.

The extension never writes the old registry file again. The records of two processes survive each other.

Do not support concurrent writes from a previous plugin version after migration.

The built-in SQLite API is experimental in Node 22.19.0. This release accepts that runtime constraint.

## Host runtime facts

The OMP host runs the Bun runtime. Bun implements the module `node:sqlite` in full.

A live OMP session opened a database through `node:sqlite`. It wrote a row and read it back.

The host exposes a stable identity for the session. The session header holds the field `id`. A session keeps it across a move.

Use that field for ownership. Do not use the session file path for that purpose.

A probe extension on the live host called `ctx.sessionManager.getSessionId()` in a `session_start` handler and in a tool call. Both calls returned the same UUIDv7. The extension reads the identity through this method.

A tool call and its result share an id. A `toolCall` block holds `id`, and a `toolResult` message holds `toolCallId`.

The tool result details persist in the transcript. Use them as the settlement evidence.

A probe of real transcripts confirmed the shape of a result that starts a background job. The details hold the job id:
`{"details":{"async":{"state":"running","jobId":"bg_5","type":"bash"}}}`

A probe of real transcripts confirmed the shape of the entry that ends a background job. The entry is a custom message, not a message:
`{"type":"custom_message","customType":"async-result","details":{"jobs":[{"jobId":"bg_5","type":"bash","status":"completed"}]}}`

The entry appears only after the job ended. The status of the job is `completed` or `failed`. The documentation of the host also names `cancelled`.

A probe of real transcripts confirmed the shape of the result of the tool `wait`:
`{"message":{"role":"toolResult","toolName":"wait","details":{"op":"wait","jobs":[{"id":"bg_1","type":"bash","status":"completed"}]}}}`

The two ways to end a job do not include each other. One job ends through exactly one of them.

A row that stays open becomes unknown when the worker stops. The owner resolves the event `execution_loss` with `wezterm_worker_resolve`.

The background work of the `job` tool reports its job id and status in the tool result details.

The command line reference states that plugin capabilities still load when the host limits the built-in capabilities.

The worker session directory names the job, so the launch context binds the report to its run.

The launch sets the variable `OMP_WORKER_SESSION_DIR` for the worker process.

The WezTerm pane inherits the environment of the process that started it, so the variable reaches the worker.

The worker bootstrap reads the run context from that directory. It gives the worker only the report tool.

The launch appends a system prompt that states the reporting contract.

A worker that does not report leaves the task state unknown. The prompt is the only way to reach it.

The report file of a run carries the run id. A resumed run does not read the reports of its source run.

## Tradeoffs

Explicit reports replace the detection of text-only completion. A completed turn does not prove a completed task.

Explicit acknowledgement replaces receipt-based handling. A saved or delivered result can stay unhandled.

Refusing live-owner displacement limits automatic recovery. It also prevents concurrent supervision after a possible stall.

At-least-once replay can repeat delivery after a crash. It cannot guarantee exactly-once external actions.

Owner resolution keeps the worker completion rule clean. The owner decides an unknown outcome without forging a report.

A resource group costs a shared identifier on each run. It removes a race between a resume and a cleanup.

An unresolved launch keeps its capacity. A lost worker holds a slot until the owner resolves it.

The release drain waits for the actions that already started. A stuck action keeps the authority with the current owner.

This decision replaces the text-only completion rule that ADR 0001 gives.

The transcript remains the evidence source. Pane text remains a diagnostic view.
