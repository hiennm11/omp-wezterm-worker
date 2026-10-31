# WezTerm Pane Workers

An OMP extension that runs a worker session independently inside a WezTerm pane
or tab. The user sees a long task run live, and the main agent keeps working.
The worker runs in OMP, in Claude Code CLI, or in Codex CLI.

## Language

**Worker**:
A separate CLI session that runs a task in a WezTerm pane and reports to a
main session. It does not inherit the main conversation.
_Avoid_: Agent, subtask, background job

**Main session**:
The OMP session that spawned the worker and receives its events.
_Avoid_: Parent session, host session

**Worker backend**:
The CLI that runs the worker: OMP, Claude Code CLI, or Codex CLI.
_Avoid_: Model, provider, agent type

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
request that WezTerm accepted is not enough.
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
_Avoid_: Style check, lint, grammar check

## Agreed supervision terms

These terms describe the supervision model. The runtime enforces the acquisition, the release and the takeover of a task. It also checks the authority of the control tools `steer`, `cancel`, `cleanup` and `resume`, of the record tools `ack` and `resolve`, and of the delivery of a result. The runtime checks the authority of the automatic path of a monitor too. The end and the stop of a monitor run as counted actions, so the release waits for them.

**Task state**:
The worker's declared condition: working, waiting, needs input, or completed.
A missing or invalid declaration leaves the task state unknown.
_Avoid_: Pane state, process health

**Supervision owner**:
The main session with exclusive authority to control a worker and deliver its events.
_Avoid_: Watcher, daemon, recipient

**Read-only session**:
A main session that sees the records of a worker and does not hold its authority.
It does not control the worker. It writes no row of a run of that worker.
_Avoid_: Observer, guest

**Acquisition**:
The first claim of a task by the main session that started its worker. The
same session claims the task again after a restart.
_Avoid_: Claim, lock, registration

**Takeover**:
The explicit handover of supervision to a main session. The previous owner
must release the task, or the extension must confirm that the process of the
previous owner ended. A session can also take back a task that it released.
_Avoid_: Resume, restart

**Worker event**:
A result, input request, or intervention condition that the main session must handle.
_Avoid_: Task, turn, notification text

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
The state that a worker declares through its own tool. It is the only evidence that the owner accepts.
_Avoid_: Answer, message, result

**Execution condition**:
What the supervisor knows about the execution of a worker. The worker started,
it runs, it stopped, it had an execution loss, or its health is unknown.
_Avoid_: Task state, worker state

**Instruction cycle**:
One stretch of worker work that starts at the task instruction or a steering input.
It ends at a terminal assistant boundary with no open tool call.
_Avoid_: Turn, assistant message, step

**Execution record**:
A durable row that holds one unit of worker execution. The row holds the start
evidence and the settlement evidence. A record that never settles keeps an
unknown state.
_Avoid_: Tool call, task, background job

**Job result**:
The end of a background job as the transcript shows it. It is an entry of the type async-result or the result of the tool wait. One job ends through one of them. Only an OMP worker has a job result today.
_Avoid_: Completion, callback

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
The end of the supervision of a task. The worker keeps running and the authority moves to another session.
_Avoid_: Cancel, stop, close

**Drain**:
The wait for the external actions that a release started before it gives the authority away.
_Avoid_: Wait, flush, cleanup

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

**Startup block**:
The state of a native worker whose session did not start. The worker waits
for the person, who accepts the trust dialog of Claude Code in the pane.
_Avoid_: Dialog, permission request, idle worker

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

**Counted action**:
An external action that the runtime counts until it settles. The release waits for the counted actions that started before it. The end and the stop of a monitor run as counted actions.
_Avoid_: Operation, call, write

**Codex identity**:
The record of a Codex worker that names its app server, its TUI, its thread and its Codex program. The payload of the run row holds the whole record, so it needs no column.
_Avoid_: Codex session, worker handle

**App server**:
The Codex program that holds the thread of a Codex worker. The extension starts one app server for each worker, and the TUI attaches to the thread of that server.
_Avoid_: Codex daemon, shared server

**Report channel**:
The path of a report from a Codex worker to the run state of its owner. The extension loads a stdio MCP server into the app server, and the server posts every report to the bridge of the run.
_Avoid_: Report file, observation queue, webhook

**Codex event**:
A message of the app server that the extension turns into an observation of a native run. The turn start, the turn end, the items and the permission requests are the events of a Codex worker.
_Avoid_: Codex message, notification, app server event

**Codex steering instruction**:
An instruction that the request `turn/steer` sends to the model of the running turn of a Codex worker. The server joins it to the turn, and the model receives it in the same turn.
_Avoid_: Queued message, prompt, follow-up
