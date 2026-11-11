# Pane Workers

An OMP extension that runs a worker session independently inside a Herdr or
WezTerm pane or tab. The user sees a long task run live, and the main agent
keeps working. The worker runs in OMP or in Claude Code CLI.

## Language

**Worker**:
A separate CLI session that runs a task in a pane and reports to a
main session. It does not inherit the main conversation.
_Avoid_: Agent, subtask, background job

**Pane runtime**:
The program that opens the pane of a worker: Herdr or WezTerm. A worker keeps
the runtime that started it, so a tool that acts on that worker later uses the
same runtime. A run that the database holds from before the runtime existed
has no runtime, and the extension never guesses one for it.
_Avoid_: Pane program, terminal, backend

**Main session**:
The OMP session that spawned the worker and receives its events.
_Avoid_: Parent session, host session

**Worker backend**:
The CLI that runs the worker: OMP or Claude Code CLI.
_Avoid_: Model, provider, agent type

**Removed backend**:
The Codex backend. It was removed by ADR 0026. A run that the database still
holds with the backend `codex` loads as history. Every tool that gets such a
run refuses it.
_Avoid_: Legacy backend, old backend

**Mod validation**:
The check that Claude Code accepts the session-scoped mod before a worker starts or resumes. Warnings do not refuse the worker.
_Avoid_: Plugin check

**Contract file**:
The file in the session directory that holds the reporting contract of a
Claude Code worker. The launch passes its path to Claude Code, because Herdr
refuses an argument with a line break. The file holds the same bytes for
every run.
_Avoid_: Bootstrap prompt file, system prompt

**Task**:
The self-contained instruction that a worker receives. It is the full input of
the worker. The worker never sees the main conversation.
_Avoid_: Prompt, request, job

**Result**:
The final task answer that a valid completion report transmits for the current
run and instruction cycle.
_Avoid_: Output, reply, response

**Preamble**:
The text that an assistant message carries alongside a tool call ("I'll read
that file."). It announces work. It does not answer.
_Avoid_: Lead-in, narration

**Steering message**:
A follow-up instruction sent to a running worker, so it changes course
without a restart.
_Avoid_: Follow-up, interrupt, correction

**Resume**:
Reopening a finished worker in a new pane from its own transcript. The worker
continues with its full history.
_Avoid_: Restart, continue, reopen

**Transcript**:
The session JSONL file of the worker. It is the authoritative record of what
the worker did and said.
_Avoid_: Log, history, session file

**Turn**:
One assistant message. A turn that issues a tool call is not the end of the
worker's work. Only a text-only turn concludes it. The missing report rule
uses the instruction cycle instead of the turn.
_Avoid_: Message, response, step

**Delivery**:
The act of putting a worker's result into the main session. The main agent
then reacts to it. A delivery that does not wake the agent is not a delivery.
_Avoid_: Notification, callback, push

**Delivery replay**:
The delivery of a result again after a restart lost it. The replay sends only
the results that the session owns and that never reached the main session.
_Avoid_: Redelivery, retry, resend

**Attachment delivery**:
The delivery of the result of a worker whose pane is gone. The attachment ends
the worker and delivers the result in the same step. The replay of a later
start cannot deliver it, because the worker ended before that start.
_Avoid_: Detached delivery, late delivery
**Event wake**:
The message that puts an actionable worker event into the main session. It
uses the channel of a delivery, and it names the event id. It happens once per
event. It holds no result text, and it never tells the worker to continue.
_Avoid_: Notification, event delivery, result delivery

**Registry**:
The file that records every worker, so a worker survives an OMP restart.
The new release keeps the records in a database. The old file stays as evidence.
_Avoid_: Index, cache, state

**Run row**:
The row of the database that holds the state of one run. A main session writes
the row only when it holds the authority of the task of that run. A session
that does not hold the authority writes no row.
_Avoid_: Registry, execution record, worker event

**Worktree**:
The isolated git checkout an isolated worker works in, on its own branch.
_Avoid_: Sandbox, clone, workspace

**Clean worktree**:
A worktree with no uncommitted changes and no untracked files. The extension
removes only a clean worktree without the user saying so.
_Avoid_: Untouched worktree, pristine worktree

**Stopped**:
The state of a worker whose pane the pane list confirms is gone. A close
request that the pane runtime accepted is not enough.
_Avoid_: Killed, terminated, closed

**Launch**:
A spawn or a resume that reached a pane. A launch that fails before the pane
exists does not count.
_Avoid_: Start, run, attempt

**Request**:
The span of work from one user prompt to the next. The limit on launches
applies to one request.
_Avoid_: Session, conversation, turn

**Usage**:
The tokens a worker used, summed from its transcript and the transcripts of
its subagents. A missing value is `unknown`, never an estimate.
_Avoid_: Consumption, cost, billing

**Communication check**:
The score that the extension gives to the text that the main session and the
workers exchange. The check starts the checker of the ste100 skill. A low
score adds a warning. The enforce mode refuses a task, a steering message and
a follow-up instruction that score below the minimum. A machine without the
skill gives the verdict skipped, and the tool never refuses a text then.
This verdict is not the acceptance verdict of a benchmark.
_Avoid_: Style check, lint, grammar check

**Thinking level**:
The level of thought that OMP gives a worker. The user selects the level of
each worker. The extension asks OMP for that level and never asks for
another. OMP maps a level that the model lacks.
_Avoid_: Effort, budget, reasoning level

**Preset**:
A named set of worker values in the configuration file. A spawn can override each preset value.
_Avoid_: Profile, template

**Restricted tool list**:
A non-empty list that limits the tools available to an OMP worker. The worker report tool is added when it is absent.
_Avoid_: Tool preset
## Agreed supervision terms

These terms describe the supervision model. The runtime enforces the acquisition, the release and the takeover of a task. It also checks the authority of the control tools `steer`, `cancel`, `cleanup` and `resume`, of the record tools `ack` and `resolve`, and of the delivery of a result. The runtime checks the authority of the automatic path of a monitor too. The end and the stop of a monitor run as counted actions, so the release waits for them.

**Task state**:
The worker's declared condition: working, waiting, needs input, or completed.
A missing or invalid declaration leaves the task state unknown.
_Avoid_: Pane state, process health

**Supervision owner**:
The main session with exclusive authority to control a worker and deliver its events.
_Avoid_: Watcher, daemon, recipient

**Main session**:
The session of the person. It holds supervision authority. Subagents cannot
control its workers. A subagent that starts a worker leaves it in this session.
The main session sets the shared message channel in `session_start`. A subagent
never sets this channel.
_Avoid_: Owner, primary session

**Subagent session**:
A session that OMP starts for an agent below the main session. It loads the
extension again in the same process. It binds no session, recovers nothing,
attaches no monitor and stops no monitor of the main session. It can read
workers and start one. It cannot control a worker.
_Avoid_: Child session, nested session, worker

**Read-only session**:
A main session that sees the records of a worker and does not hold its authority.
It does not control the worker. It writes no row of a run of that worker.
_Avoid_: Observer, guest

**Acquisition**:
The first claim of a task by the main session that started its worker. The
same session claims the task again after a restart. It claims the task back
when the lease of its session is free.
_Avoid_: Claim, lock, registration

**Session lease**:
The hold that OMP keeps for a session. The key of the hold is the session id.
A process holds the lease of a session at the first write of that session.
The host releases the lease when the session closes. The kernel releases it
when the process exits. The lease proves that no process holds the session.
_Avoid_: Session lock, session file, process table

**Takeover**:
The explicit handover of supervision to a main session. The previous owner
must release the task, or the extension must confirm that the process of the
previous owner ended. A session can also take back a task that it released.
_Avoid_: Resume, restart

**Worker event**:
A result, input request, or intervention condition that the main session must handle.
_Avoid_: Task, turn, notification text

**Result event**:
The actionable event that represents a completed or failed worker result. The delivery carries its id, and the main session must acknowledge it.
_See also_: Handling acknowledgement

**Expired event**:
A no-action event that the owner closes after its run and event exceed the expiry limit. The system records `expired`. It does not delete the event row.
_Avoid_: Accepted event, discarded event

**Handling acknowledgement**:
The main session's record that it handled a worker event and chose a
disposition. Receipt or inspection alone does not count as handling
acknowledgement.
_Avoid_: Delivery, acceptance

**Result acceptance**:
The main session's decision that a worker result satisfies its requirements.
_Avoid_: Task completion, delivery

**External wait**:
A declared pause for a named dependency whose change the worker can observe.
_Avoid_: Stall, task completion

**Pending worker event**:
A worker event that remains unhandled and still needs action from the main session.
_Avoid_: Unread message, undelivered result

**Execution loss**:
The confirmed end of a worker's execution when no evidence settles its task outcome.
_Avoid_: Task failure, completion

**Legacy result**:
A saved answer whose completion used the earlier text-only rule and remains unverified.
_Avoid_: Explicit completion, accepted result

**Report**:
The state that a worker declares through its own tool. Claude saves the report
in the run's JSONL file before it posts to the bridge. The owner reads that file
when it restores a released run. Claude also saves background observations in
a separate run JSONL file, so the owner can settle execution rows after takeover.
The report is the only evidence that the owner accepts.
_Avoid_: Answer, message, result

**Execution condition**:
What the supervisor knows about the execution of a worker. The worker started,
it runs, it stopped, it had an execution loss, or its health is unknown.
_Avoid_: Task state, worker state

**Instruction cycle**:
One stretch of worker work that starts at the task instruction or a steering input.
It ends at a terminal assistant boundary. That boundary is an assistant message
that ends its turn with text and holds no tool call. A tool result that follows
the last assistant message keeps the cycle open.
_Avoid_: Turn, assistant message, step

**Execution record**:
A durable row that holds one unit of worker execution. The row holds the start
evidence and the settlement evidence. A record that never settles keeps an
unknown state.
_Avoid_: Tool call, task, background job

**Job result**:
The end of a background job as the transcript shows it. It is an entry of the type async-result, the result of the tool wait, the result of a read of `proc://bg_N` or the result of a kill of that job. One job ends through one of them. Only an OMP worker has a job result today.
_Avoid_: Completion, callback


**Declared background command**:
A command that outlives its turn and that the worker declares with `wezterm_worker_background`. Its open execution record blocks a completed report until the worker settles it.
_Avoid_: Background job
**Outstanding execution**:
An execution record that is open or unknown. It blocks a completion report.
_Avoid_: pending call

**Resource group**:
The shared transcript directory and worktree that two runs of one task use.
A run finds its group through its session directory.
_Avoid_: Session directory, worktree, task

**Group release**:
The end of the reservation of a resource group. A run releases its group when
the run ends and its pane is gone. The startup recovery releases a group whose
holder ended and whose pane is gone. A resume and a cleanup release a group
whose holder ended and whose pane is gone.
_Avoid_: Cleanup, deletion, cancel

**Launch attempt**:
One attempt to start a worker, with its own identity and reservation state.
The owner of the task settles it. Another session leaves it alone.
_Avoid_: Launch, spawn, request

**Unresolved launch**:
A launch attempt that a crash left without a receipt. It holds no counted capacity. It raises one event and waits for the owner.
_Avoid_: Failed launch, lost worker, uncertain launch

**Owner resolution**:
The owner's record of an unknown task outcome. It does not create a worker completion report.
_Avoid_: Acknowledgement, report, result acceptance

**Disposing**:
The state of a resource group whose deletion started. It refuses every new run against it.
_Avoid_: Deleted, cleaned, closed

**Release**:
The end of the supervision of a task. The worker keeps running and the authority moves to another session. The session that released the task keeps no bridge, no client and no run state of the worker, so no observation of the worker reaches it any more.
_Avoid_: Cancel, stop, close

**Drain**:
The wait for the external actions that a release started before it gives the authority away.
_Avoid_: Wait, flush, cleanup

**Closing release**:
The release that a main session makes when its session closes. It gives back
the tasks that the session still supervises. The next program of the same
session takes over the running worker through the released row. The answer of
the lease is not evidence that the old owner is alive, because the new program
holds the lease itself.
_Avoid_: Session end, disposal, shutdown

**Session switch**:
The host event that confirms a move to another session. The extension releases
the tasks of the old session, binds the new session id, and attaches tasks that
the new session already owns. See ADR 0022.
_Avoid_: Session start, shutdown

**Native bridge**:
The link that connects a native worker to the main session. It carries the
observations of the worker and the commands of the owner. A new owner starts a
new bridge, and the worker follows it through the handover file.
_Avoid_: Plugin, adapter, socket

**Session-scoped mod**:
The Claude Code plugin that a worker session loads. It lives in the session directory of the worker and holds the report tool.
_Avoid_: Extension, plugin directory, hook

**Accepted input**:
An instruction that the native program accepted. It is not yet a delivered input.
_Avoid_: Received message, queued message, receipt

**Delivered input**:
An accepted instruction that the native program transmitted into a cycle.
_Avoid_: Accepted input, processed message

**Permission request**:
A native request that asks the person for the approval of a call. The person
answers it in the pane.
_Avoid_: Approval, tool check, dialog

**Approval policy**:
The setting that decides when a native worker asks the person for the approval
of a command. The values are `untrusted`, `on-request` and `never`. No value
means that the worker keeps the policy of the user.
_Avoid_: Sandbox mode, permission, approval mode

**Startup block**:
The state of a native worker whose session did not start. The worker waits
for the person, who accepts the trust dialog of Claude Code in the pane.
_Avoid_: Dialog, permission request, idle worker

**Thinking stall**:
An OMP worker cycle that remains in the thinking state for 600 seconds after its last transcript entry. It raises one event for the owner.
_Avoid_: Missing report, idle worker

**Report reminder**:
The instruction that the extension sends into the pane of a worker whose cycle ended without a report. One cycle gets one reminder. The reminder goes to the pane of that worker only. The owner wakes when the worker does not report within the grace of the reminder.
_Avoid_: Steer, wake, notification

**Native cycle**:
The native turn that carries one instruction. A cycle starts at the accepted instruction and ends when its turn ends.

**Run snapshot**:
The account that a native worker gives to a new owner about its own state. The
account names the current cycle, the instruction that waits for a cycle, the
calls that run and the permission requests that wait.
_Avoid_: Checkpoint, state dump, sync

**Restored run**:
A native run whose owner starts again. The run holds only what the new owner
saw since then and what the run snapshot told it. Its counts of turns and
tokens start at the restart.
_Avoid_: Recovered run, resumed run

**Native background task**:
A command that a native worker starts in the background. It settles through its own notification or through a stop of the task, and not through the return of the call that started it.
_Avoid_: Background call, foreground tool, background job

**Measured usage**:
The token counts that the native program reported for its turns. A count that the program did not report stays missing.
_Avoid_: Estimated cost, token estimate, zero usage

**Pending event**:
An event of a worker that nobody handled yet. The status tool lists it, and the owner acknowledges it with its event id.
_Avoid_: Open event, unread event, notification

**Stop intent reconciliation**:
The act of settling the stop intents that a restart left pending. It reads the pane state of each run. A gone pane confirms the intent, and an existing pane fails the intent.
_Avoid_: Stop retry, pane check, intent repair

**Monitor authority**:
The authority that a session needs to end a worker with its monitor. A session that released its task, or that lost it to another session, has no monitor authority and its monitor stops without a write.
_Avoid_: Ownership, monitor, session identity

**Supervision line**:
The line of the status tool that tells if a monitor of this process watches an active worker. The line `NOT SUPERVISED` names a task that this process owns without a monitor. The line `read-only here` names a task that another session or process owns, and it does not claim that the owner is gone.
_Avoid_: Orphan, unsupervised, ghost

**Counted action**:
An external action that the runtime counts until it settles. The release waits for the counted actions that started before it. The end and the stop of a monitor run as counted actions.
_Avoid_: Operation, call, write

**Open turn**:
The cycle of a run that no completed turn closes. A stop interrupts the open turn of a native worker before it ends the program of the worker.
_Avoid_: Running turn, current cycle

**Released client**:
A bridge that its session closed with a release. A closed bridge delivers no message to its handler, so the released session receives no observation of the worker.
_Avoid_: Live client, stale client

**Report file**:
The file of a session directory that holds the reports of a run. The file keeps a report that arrived while no owner held the task.
_Avoid_: Transcript, log, bridge

**Proof**:
A run of the protocol harness in `tooling/backend-proof/` against a real native program. It shows what the native program does. It never shows what the extension does.
_Avoid_: Smoke, end-to-end test, trial

**Smoke**:
A run of the real extension through its own tools against a real native program. It shows what the extension does. A criterion of a backend closes with a smoke or with a test of the behavior, and never with a proof alone.
_Avoid_: Proof, trial, integration test

**Direct input**:
A task text that the person types into the pane of a running native worker. It joins the same run and opens a new instruction cycle. The arrival of the input and its native delivery are separate evidence.
_Avoid_: Steering input, manual prompt

**Worker channel**:
The shared space where the main session and one worker exchange channel notes.
It belongs to one task. Each side writes its own file in the session
directory, and a resume of the task finds the same files. A note never steers
a worker and never wakes the main session.
_Avoid_: Board, message, agent

**Channel note**:
A short piece of free text that travels over a worker channel. It changes no
state of the task. A note of the worker names the run that wrote it, and a
note of the main session names no run. The text holds 4000 characters at
most.
_Avoid_: Board, message, agent

## Eval terms

**Experiment**:
One run of one task with one model and one effort. It holds evidence. It is not the result of a worker.
_Avoid_: Trial, test run, benchmark

**Benchmark run**:
Every experiment of one plan, written to one artifact directory.
_Avoid_: Batch, session, evaluation

**Acceptance verdict**:
The value `PASS`, `FAIL` or `BLOCKED` that an external verifier gives a fixture. The report of a worker never sets it. A verdict of the communication check is not an acceptance verdict.
_Avoid_: Job status, worker report, self-assessment

**Dataset version**:
The version string of a dataset directory. A change to a fixture, a task text or a verifier changes the version.
_Avoid_: Dataset tag, snapshot

**Fixture checksum**:
The SHA-256 of the sorted list of the paths and bytes of a fixture. It proves that two runs started from the same tree.
_Avoid_: Hash, fingerprint

**Protected path**:
A path that the runner copies from the dataset template before the verifier runs. It stops a worker from weakening a test.
_Avoid_: Read-only file, immutable path

**Measured cost**:
The cost that the provider reported for a model call, summed from the transcript. A missing value stays `unknown`.
_Avoid_: Estimate, price table, zero cost

