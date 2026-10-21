# Recoverable long OMP tasks

Status: proposed implementation plan. ADR 0009 records the accepted behavior.
This revision corrects six blockers in the implementation and two omissions in the verification.
The implementation of this plan is in the repository. The acceptance matrix below
names the observation that each test must make.

## Release goal

Long OMP tasks recover after process failure and hand over actionable events without concurrent supervision.
Use separate review steps and one release gate. Do not publish partial supervision as the complete guarantee.
Add no daemon, routine LLM watcher, external execution observer, or Claude/Codex adapter.
Guarantee process recovery. Machine shutdown recovery remains best effort.

## Host capability evidence

The slices below depend on host facts. Each fact below was checked against the
installed host or against the primary documentation. A fact marked "confirm" still
needs a runtime check. The first slice runs those checks before it writes code.

| Capability | Evidence | State |
| --- | --- | --- |
| OMP version and flags | `omp --version` reports 18.12.4. The binary sits at `C:/Users/Admin/AppData/Local/omp/omp.exe`. The help text lists `--extension`, `--append-system-prompt`, `--tools`, `--resume`, and `--session-dir`. | confirmed |
| Extension runtime | The OMP binary carries Bun v1.4.3. Bun implements `node:sqlite` in full. | confirmed |
| SQLite in the repository | The repository runs Node v22.19.0. The module `node:sqlite` exists there and prints an experimental warning. | confirmed |
| SQLite in the live host | A live OMP session opened a database through `node:sqlite`, wrote a row, and read it back. | confirmed |
| Stable session identity | The version 3 session header holds the field `id`, a UUIDv7 that a session keeps across a move. A real session file under `~/.omp/agent/sessions` holds this header. | confirmed |
| Session file path | The host context exposes `sessionManager.getSessionFile()`. The repository declares it in `extensions/lib/host.ts`. | confirmed |
| Tool call and result pairing | A `toolCall` block holds the field `id`. A `toolResult` message holds the field `toolCallId`. The session format document requires the pair to match by value. | confirmed |
| Tool result details | A `toolResult` message persists its `details` object in the transcript. A real transcript holds the details of a read tool call. | confirmed |
| Background work | OMP offers the `job` tool for background work. Its result details hold the job id, the job type, and the job status. | confirmed |
| Worker report bootstrap | An extension registers its own tools. The command line reference states that plugin capabilities still load when the built-in capabilities are restricted. | confirmed |
| Worker context binding | The extension passes `--session-dir <stateDir>/sessions/<jobId>`. The worker session directory therefore names the job. | confirmed |
| Pane identity | WezTerm sets the variable `WEZTERM_PANE` in the environment of the program it starts in a pane. A pane that started through `wezterm cli split-pane` reported the same id that the command returned. | confirmed |
| Process incarnation | Windows reports the command line, the creation time, and the parent id of every process. A running OMP process shows them. | confirmed |
| Worker process role | The launch sets `OMP_WORKER_SESSION_DIR` for the pane. A pane inherits the environment of the process that started it. A probe pane confirmed the variable arrives. | confirmed |
| Report bootstrap | The launch appends a system prompt from a file. A real worker process read the contract and called the report tool. The report file held the run id, the state, and the result. | confirmed |

Two earlier assumptions do not hold. The repository shares the transcript and the
worktree with a resumed run instead of copying them. The host also exposes a
stable session identity, so the plan does not need the session file path for
ownership.

The host runtime is Bun, not Node. Bun implements `node:sqlite` in full, so
the same import works in the host and in the repository test run.

## State and authority

Keep execution condition, declared task state, and event handling separate.
Execution evidence distinguishes startup, live execution, confirmed stop, execution loss, and unknown health.
Task reports use working, waiting, needs_input, or completed. Missing valid evidence means unknown.
Worker completion does not mean result acceptance. Execution loss does not prove task failure.

Each launch or resume has a distinct run identity, even when it shares an older transcript.
Bind accepted reports to the run, the worker session, and a transcript position after its baseline.
Only successful reporting tool results count as reports. Tool arguments alone do not prove a report succeeded.
Ordinary answer text, pane text, transcript growth, and an open pane never prove task completion.

Each task has one main session owner and one owning process incarnation.
Use a generation value to reject writes from previous owners. Keep authority checks inside write transactions.
Read-only inspection does not acquire ownership. A worker process never becomes a supervision owner.

The ownership row holds a phase: active, releasing, or released.
An operation gate in the owner scope serializes two actions. It serializes the start of an external action and the move into the releasing phase.
A generation number cannot fence an action that already started. The plan does not claim that it can.
The release operation guards the external actions of one owner.

## Storage contract

Use one SQLite database in the configured state directory through node:sqlite.
Store runs, ownership, launch reservations, events, acknowledgements, and migration status in transactions.
Keep transactions short. Do not hold a write transaction across process commands or message injection.
Serialize admission across all owners. Persist results and their pending events in the same transaction.
Use bounded database contention handling. Surface a failed write instead of reporting unsaved success.

Read transcripts as evidence. Store the accepted evidence position with each state transition.
Import registry.json once under an atomic migration transaction. Preserve the source file.
Keep legacy historical results unverified and passive. Active legacy records require reconciliation and an owner decision.
Reject malformed migration input without replacing or deleting it.
Do not run old plugin versions against migrated storage. Document the upgrade and runtime requirements.

The database also stores four new record kinds.

- A launch attempt holds an attempt id, a job id, a reservation state, and the worker identity.
- A resource group holds the shared transcript directory, the isolated worktree, an execution reservation, and a disposal marker.
- An execution record holds an execution id, start evidence, observation method, and settlement evidence.
- An owner resolution holds the event id, the resolution, the evidence note, and the owner identity.

## Proposed tool interface

Preserve existing tool names. Record new schemas and changed semantics in ADR 0009 before implementation.
Put each new tool in its own worker-tools module. Keep lifecycle behavior in lib.

- wezterm_worker_report: worker-only reporting of the current run state and supporting details.
- wezterm_worker_ack: owner-only acknowledgement by worker ID, event ID, disposition, and handling note.
- wezterm_worker_takeover: explicit acquisition after release or confirmed owner exit.
- wezterm_worker_release: stop supervision and release authority without stopping the worker.
- wezterm_worker_retry_delivery: explicitly resend one pending event under its existing event ID.
- wezterm_worker_resolve: owner-only resolution of an unknown task outcome by worker ID, event ID, resolution, and evidence note.

A completed report includes its result. A waiting report names its dependency and observable resume condition.
A needs_input report includes the decision or information needed. Working reports cannot hide an execution gap.
Reports cannot select another task or update lifecycle records directly.
The worker bootstrap exposes reporting even when a caller restricts its other tools.

Acknowledgement dispositions distinguish accepted, follow_up, and discarded.
Repeated identical acknowledgements succeed without another effect. Conflicting acknowledgements return the existing disposition and a clear refusal.
A disposition concerns event handling. It does not overwrite worker completion evidence.

Status and result replies expose execution condition, task state, ownership, evidence, and pending events separately.
Reading a result does not acknowledge it. Include the event ID and acknowledgement instruction in each delivery.

## Implementation slices

### 1. Transactional storage and migration

Run the capability checks of the host capability section first. Do this before the migration code.
Report the exact missing prerequisite when a check fails. Do not replace it with inference.

Replace whole-registry writes in registry.ts and runtime.ts with transactional storage operations.
Add focused lib modules for database setup, migration, and transactional records as responsibility requires.
Add the run model, event model, and ownership generation to job.ts or focused domain modules.
Remove writable JSON persistence after migration. Keep no dual-write path.
The old registry file stays on disk as the evidence of the migration.

Verify SQLite inside the actual OMP extension host, not only the standalone Node executable.
Verify access to a stable main session identity and the worker launch context in that host.
Verify process-incarnation detection on native Windows through the existing process execution seam.
Read the session identity from the header field `id` of the session file. Do not use the file path for that purpose.

Acceptance: two processes update different tasks without lost writes. Migration repeats without duplicate records.
An interrupted transaction leaves either the previous state or the complete next state. It never leaves half a result and event pair.

### 2. Ownership, admission, and host routing

Acquire task authority atomically using session identity, process identity, and generation.
Confirm owner exit through process evidence. A PID without its incarnation is not enough authority evidence.
Treat an unreadable process probe as unknown. Refuse takeover while ownership remains uncertain.
Permit original-session recovery only after the previous owner exits. Require explicit cross-session takeover.
A second live process for the same session remains read-only for already-owned tasks.

Replace factory rebinding of mutable global routing with owner-scoped host bindings in WorkerRuntime.
Keep the runtime creation in the entry. Keep the entry wiring-only.
Worker bootstrap must not restore monitors or deliver unrelated registry events.
Guard spawn, resume, steer, cancel, release, cleanup, acknowledgement, resolution, and delivery with current authority.
Reserve shared active-worker capacity atomically. Keep request limits local to the main session.

Each launch attempt holds a reservation with one of five states: reserved, issued, attached, unused, or unresolved.
The reserved state means that the attempt row exists and that no command has run yet.
The issued state means that the command was sent and that the pane may or may not exist.
The attached state means that the pane id and the worker identity are both known.
The unused state means that the command failed before any worker started. The capacity becomes free again.
The unresolved state means that a crash left the attempt without a receipt.

Persist the reserved state before the spawn command runs. Persist the issued state before the command runs.
Persist the attached state with the correlated pane receipt.
After a crash, find the live worker by the process command line, the session file header id, and the pane id.
A matched worker becomes attached, and the lost receipt is repaired.
No match is not proof that no worker exists. The attempt becomes unresolved, and the capacity stays reserved.
An unresolved attempt creates one intervention event. The supervisor never sends the command again.
Only a confirmed unused attempt or an explicit owner resolution frees an uncertain reservation.
The capability checks of slice 1 confirm the correlation before this slice lands.
If the correlation fails, the manual owner resolution stays the only outcome for that crash window.

The release operation moves the phase to releasing in one transaction. It refuses new external actions after that.
The release waits for the actions that already started. It commits the released phase only after they finish.
A wait that times out leaves the phase releasing. The release returns the action that did not settle and keeps the authority.
The extension persists a stop intent before it sends a destructive pane command.
A recovered owner reconciles that stop intent before it steers, resumes, or cleans up.
A command that ran before a crash cannot be taken back. The reconciliation reads the pane state.

Every launch and every resume belongs to a resource group. The group names the shared transcript directory and the isolated worktree.
A spawn creates a group. A resume keeps the group identity of its source run.
The resume reserves execution for the group in one transaction. It does this before it reads the baseline and before it starts a pane.
The resume fails when another run in that group holds a reservation, a live execution, a stopping execution, or an unknown execution.
The resume also fails when the previous pane is still present or when its health is unknown.
A run that declared completion does not free the group while its pane lives.
The owner can still read a completed pane before the owner closes it.

Acceptance: duplicate owners cannot control one task. Independent owners can control different tasks.
An old generation cannot write. An old owner cannot notify after an orderly release.
Concurrent launches cannot exceed the shared limit. Failure before launch releases a confirmed unused reservation.
A release that waits for a running action commits only after the action finishes.

### 3. Explicit reports and task decisions

Install the reporting tool in launched and resumed worker contexts through the OMP launch interface.
Bind it to the current run. Keep reporting evidence in the worker transcript. Do not use a second registry writer.
The report file of a run carries the run id. A resumed run shares the session directory of its source run.
The launch appends a system prompt that states the reporting contract.
The launch sets the variable `OMP_WORKER_SESSION_DIR`, so the worker knows that it is a worker.
The WezTerm pane inherits the environment of the process that started it, so the variable reaches the worker.
Update spawn.ts, transcript.ts, monitor.ts, and lifecycle.ts to consume successful structured reports.
Replace finished-turn success detection. Remove obsolete text-only success paths and their incidental tests.
Use pure decisions for evidence reconciliation, state transitions, and intervention event selection.

Each run holds an execution ledger. Each row holds an execution id, start evidence, observation method, and settlement evidence.
A row opens when the transcript shows a tool call that carries an id.
A row settles when a tool result message carries the same call id. A result for one call never settles another call.
A row for background work stays open until a later tool result names the same job id and reports that it no longer runs.
A call that the transcript shows without its result after a crash keeps an unknown state.
The owner resolves an unknown row. The supervisor never guesses that the call finished.
An unknown row blocks a completion report.
Do not infer settlement from an open pane, from transcript growth, or from an empty current tool value.
Completion never claims universal discovery of detached processes.

The unit of the missing report rule is one instruction cycle. It is not one assistant message.
A cycle starts at the accepted task instruction or at a steering input.
A cycle ends at a verified terminal assistant boundary with no open foreground calls.
A partial transcript or an open tool call does not close a cycle.
A cycle must hold at its terminal boundary for a settling time before the rule applies.
The worker writes its report in the turn after its answer, so a cycle that closes at once is still settling.
The event key joins the run id, the evidence id of the cycle start, and the condition kind.
A recovery cannot create a second event for the same cycle.
A report inside the cycle satisfies the report requirement. Later ordinary text does not remove it.
A working report followed by a verified idle execution is a separate condition. It creates its own event.
A later valid report can resolve an obsolete event. The history of that event stays.

Silent active execution remains status information. Waiting requires the worker to retain observation of the dependency.
A needs_input report creates an actionable event but does not complete or automatically close the worker.
Known outstanding task execution blocks completion. The worker must observe background results before reporting completion.

Acceptance: a background-build answer cannot become success. Old-run reports cannot finish resumed runs.
Working, waiting, needs_input, completed, and unknown produce distinct observable behavior.
Two open tool calls settle one by one. One result cannot clear both.

### 4. Evidence-first recovery and stop precedence

Reconcile stored records and new transcript evidence before evaluating missing panes or expired deadlines.
Use the same reconciliation decisions during live monitoring and startup recovery.
Recover valid completion even after pane loss. An unreadable pane list remains unknown.
Record execution loss without inventing a task outcome. Emit one intervention event and never restart automatically.

Reconcile every launch attempt that a crash left without a receipt. Use the correlation of slice 2.
An attempt that finds its worker becomes attached. An attempt that finds nothing becomes unresolved.
An unresolved attempt keeps its capacity and creates one intervention event.

Committed completion precedes a later cancel. Durable stop intent precedes later completion evidence.
Keep a late answer as evidence. Confirm pane closure before assigning the requested stop outcome.
Recover completion before enforcing an expired deadline when no stop intent exists.
Keep deadlines running during owner absence, but state that enforcement requires a live supervisor.
Remove idle-time stopping. Reject nonzero legacy idleTimeoutMs values with migration guidance.

Acceptance: pane loss after completion recovers the result. Incomplete evidence remains unknown.
Completion/cancel races follow transaction order. An unconfirmed stop stays observable and cannot permit another writer.
A crash after the pane creation and before the receipt never starts a second worker.

### 5. Durable events, handling, and cleanup

Create one stable event per report or intervention condition. Reconciliation cannot duplicate that event.
Store the result and pending completion event atomically before any pane close or notification attempt.
Restore authority and monitoring before replaying pending events.
Attempt automatic delivery once per activation. Polls never repeat a wake for the same pending condition.
Replay after recovery or takeover under the same event ID. Support explicit retry.
Catch delivery failures and preserve the event. Do not acknowledge on successful message injection.

Each delivery attempt keeps the event identity and the owner generation.
The attempt is recorded before the message goes out.
An attempt that settled and an attempt of uncertain outcome stay distinct from a handling acknowledgement.
A host that refuses the message leaves the attempt uncertain, and the event stays pending.

The owner resolution operation settles an unknown task outcome without forging a worker completion.
The operation takes the worker id, the event id, the resolution, and an evidence note.
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

The cleanup marks the resource group disposing in one transaction.
The cleanup does this only when no run holds an execution reservation and no linked event is unhandled.
A disposing group refuses every resume and every launch against it.
The marker stays in place until the external deletion finishes.
A crash during the deletion leaves the group disposing. The recovery reconciles it.
The force option affects worktree changes only. It never skips the execution check or the event check.
Use the persisted resource references. Do not use a scan of the process-local worker map.

Persist an owner disposition through the acknowledgement tool. Reject calls from another owner.
Resolve obsolete input requests only from evidence that their condition no longer applies.
Keep history and keep later completion as a separate event.
After cleanup, retain a compact handled event record so repeated acknowledgement remains safe.

Acceptance: crashes before send and after send do not lose handling. Acknowledged events never replay.
Repeated handling does not repeat lifecycle actions. Arbitrary external side effects remain outside exactly-once guarantees.
A legacy task reaches an owner resolution without a relabel as a worker completion.

### 6. Complete release proof

Update existing affected tests and add behavior tests for uncertain transitions, ordering, and crash windows.
Write one test file for each case of the new acceptance cases table. Name the file after the case.
Every decision test must run without a pane. Use pure functions of the job, the clock, and the stored records.
Every integration test task asks the worker to report its state. A worker that never reports never finishes.
A test that waits for an answer accepts a report as well, because a report is the stronger evidence.
Use isolated databases and real separate processes for concurrency and crash recovery.
Extend the existing integration harness with stable session identities and distinct host bindings.
Add a repeatable native Windows trial under tooling. Use real OMP workers and real WezTerm panes.
Run a worker through an external wait, supervisor termination, recovery, completion, acknowledgement, and restart.
Exercise the main-session wake and handling tools on the actual host. Do not substitute mock delivery for that proof.
Use short deadlines for deterministic boundary checks. Also run a real task across the old 30-minute boundary.
Record the configured deadline and observed result. An accelerated clock alone does not prove long execution.

The steering test of `tests/live-worker.integration.test.ts` is a baseline check for the steering path.
An earlier report said that the worker did not answer the steering message. That report had no saved artifact.
The cause was the reporting contract. A worker that reports its state writes no answer text.
The test now accepts a report as the evidence, because a report is the stronger evidence.
It passed on omp 18.12.4 after that change. Do not raise the timeout to obtain a pass.
Report a failure that the new behavior causes.

Update README.md, the companion skill, the example configuration, GLOSSARY.md, and affected ADRs.
Update installer and uninstaller behavior for the new storage and removed idle-stop setting.
Register every agent document in the document checker. Update the repository layout for new modules.
Keep source files at 350 lines or fewer. Split by responsibility, not line count alone.
Run npm run check after integration. Report every skipped or unavailable live test.
Request a correctness review after implementation and verify each material finding before changing code.

## Release acceptance matrix

Every row names an observation that a test must make.
The rows of the first table keep the accepted behavior of ADR 0009.
The rows of the second table close the eight findings of the review. No test exists for them yet.

| Group | Required observations |
| --- | --- |
| Explicit task state | Background build is not success; missing or invalid report is unknown; old reports cannot finish a new run. |
| Execution evidence | Silent execution survives; idle working report requests intervention once; known running writers block completion. |
| External wait | Named dependency and resume condition survive recovery; disappearance requests intervention without automatic restart. |
| Recovery | Completed task survives pane loss; incomplete evidence stays unknown; unreadable health evidence is not death. |
| Deadlines and stops | Active deadline is enforced; absent-owner completion recovers; stop intent wins later reports; closure must be confirmed. |
| Durable events | Crash before send and after send both replay the same ID; result and event never split across a transaction. |
| Handling | Duplicate acknowledgement is safe; conflicting acknowledgement refuses; handled events do not replay. |
| Wake control | Observation polls do not resend; explicit retry and owner recovery can resend; obsolete input requests stop replaying. |
| Ownership | Same-task dual control refuses; different tasks remain concurrent; unknown owner health blocks takeover. |
| Host routing | Duplicate session stays read-only; worker bootstrap cannot supervise others; events reach only the current owner's session. |
| Storage and admission | Concurrent writes retain both results; concurrent launches respect the shared limit; migration is one-time and preserves evidence. |
| Legacy and cleanup | Historical results remain unverified and passive; active legacy state needs a decision; pending handling blocks cleanup. |
| Actual long execution | Real OMP task crosses 30 minutes under a suitable deadline and recovers before correct handover. |

## New acceptance cases for the corrected design

| Case | Required observation |
| --- | --- |
| Launch recovery | A crash after the pane creation and before the receipt finds the worker or raises one unresolved launch event. It never starts a duplicate. |
| Release ordering | A release that meets a notification or a pane control stops every action that starts after the releasing phase. A takeover cannot come before the drain ends. |
| Stop intent | A pending destructive intent is reconciled before any new control after the owner died. |
| Resource exclusion | A resume that meets a cleanup leaves a reserved run with intact resources or a disposing group that refuses a resume. |
| Second writer | A completed old run with a live or unknown pane cannot launch a second writer against its transcript. |
| Report interval | A completed report followed by ordinary text creates no missing report event. |
| Tool call pairing | Two open tool calls settle one by one. One result cannot clear both. |
| Background settlement | A background execution record survives a restart and blocks completion until a valid settlement arrives. |
| Legacy resolution | An active legacy task reaches an explicit owner resolution without a relabel as a worker completion. |

## Approval

All behavior choices through Q25 are accepted. Module names can change to match local responsibilities.
The storage and tool contracts above form the proposed implementation seam. They require final approval before code changes.
This plan is not implementation ready while a capability of the host capability section still needs a check.
A failed check keeps its blocker. Name the exact missing prerequisite instead of choosing a weaker guarantee.
The release is complete only when every acceptance group passes or the user explicitly changes the scope.
