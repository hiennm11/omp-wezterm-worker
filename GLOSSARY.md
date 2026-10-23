# WezTerm Pane Workers

An OMP extension that runs an independent worker session inside a WezTerm pane
or tab, so the user watches a long task live while the main agent keeps
working. The worker runs in OMP, in Claude Code CLI, or in Codex CLI.

## Language

**Worker**:
An independent CLI session that runs a task in a WezTerm pane and reports to a
main session. It does not inherit the main conversation.
_Avoid_: Agent, subtask, background job

**Main session**:
The OMP session that spawned the worker and receives its events.
_Avoid_: Parent session, host session

**Worker backend**:
The CLI that executes the worker: OMP, Claude Code CLI, or Codex CLI.
_Avoid_: Model, provider, agent type

**Task**:
The self-contained instruction a worker receives. It is the worker's entire
input; the worker never sees the main conversation.
_Avoid_: Prompt, request, job

**Result**:
The final task answer carried by a valid completion report for the current run
and instruction cycle.
_Avoid_: Output, reply, response

**Preamble**:
The text an assistant message carries alongside a tool call ("I'll read that
file."). It announces work, it does not answer.
_Avoid_: Lead-in, narration

**Steering message**:
A follow-up instruction sent into a worker that is still running, so it
changes course without restarting.
_Avoid_: Follow-up, interrupt, correction

**Resume**:
Reopening a finished worker in a new pane from its own transcript, so it
continues with its full history.
_Avoid_: Restart, continue, reopen

**Transcript**:
The worker's session JSONL file. It is the authoritative record of what the
worker did and said.
_Avoid_: Log, history, session file

**Turn**:
One assistant message. A turn that issues a tool call is not the end of the
worker's work; only a text-only turn concludes it.
The missing report rule uses the instruction cycle instead of the turn.
_Avoid_: Message, response, step

**Delivery**:
The act of putting a worker's result into the main session so the main agent
acts on it. A delivery that does not wake the agent is not a delivery.
_Avoid_: Notification, callback, push

**Registry**:
The file that records every worker, so a worker survives an OMP restart.
The new release keeps the records in a database. The old file stays as evidence.
_Avoid_: Index, cache, state

**Worktree**:
The isolated git checkout an isolated worker works in, on its own branch.
_Avoid_: Sandbox, clone, workspace

**Clean worktree**:
A worktree with no uncommitted changes and no untracked files. Only a clean
worktree may be removed without the user saying so.
_Avoid_: Untouched worktree, pristine worktree

**Stopped**:
The state of a worker whose pane is confirmed gone. A close request that
WezTerm accepted is not enough.
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
workers exchange. A low score adds a warning. The enforce mode refuses a task
and a steering message that score below the minimum.
_Avoid_: Style check, lint, grammar check

## Agreed supervision terms

These terms describe the supervision model. The runtime enforces the acquisition and the release of a task. It does not yet enforce the takeover, and it does not check the authority of every action.

**Task state**:
The worker's declared condition: working, waiting, needs input, or completed.
A missing or invalid declaration leaves the task state unknown.
_Avoid_: Pane state, process health

**Supervision owner**:
The main session with exclusive authority to control a worker and deliver its events.
_Avoid_: Watcher, daemon, recipient

**Acquisition**:
The first claim of a task by the main session that started its worker, and the renewed claim of the same session after a restart.
_Avoid_: Claim, lock, registration

**Takeover**:
An explicit transfer of supervision to a different main session after the previous owner releases authority or exits.
_Avoid_: Resume, restart

**Worker event**:
A result, input request, or intervention condition that the main session must handle.
_Avoid_: Task, turn, notification text

**Handling acknowledgement**:
The main session's record that it handled a worker event and chose a disposition.
Receipt or inspection alone is not handling acknowledgement.
_Avoid_: Delivery, acceptance

**Result acceptance**:
The main session's decision that a worker result meets its requirements.
_Avoid_: Task completion, delivery

**External wait**:
A declared pause for a named dependency whose change the worker can observe.
_Avoid_: Stall, task completion

**Pending worker event**:
A worker event that remains unhandled and still requires action from the main session.
_Avoid_: Unread message, undelivered result

**Execution loss**:
The confirmed end of a worker's execution without evidence that settles its task outcome.
_Avoid_: Task failure, completion

**Legacy result**:
A saved answer whose completion used the earlier text-only rule and remains unverified.
_Avoid_: Explicit completion, accepted result

**Report**:
The state that a worker declares through its own tool. It is the only evidence that the owner accepts.
_Avoid_: Answer, message, result

**Execution condition**:
What the supervisor knows about the execution of a worker: it started, it runs, it stopped, it is lost, or its health is unknown.
_Avoid_: Task state, worker state

**Instruction cycle**:
One stretch of worker work that starts at the task instruction or a steering input.
It ends at a terminal assistant boundary with no open tool call.
_Avoid_: Turn, assistant message, step

**Execution record**:
A durable row that holds one unit of worker execution, its start evidence, and its settlement evidence.
A record that never settles keeps an unknown state.
_Avoid_: Tool call, task, background job

**Resource group**:
The shared transcript directory and worktree that two runs of one task use.
_Avoid_: Session directory, worktree, task

**Launch attempt**:
One attempt to start a worker, with its own identity and reservation state.
_Avoid_: Launch, spawn, request

**Unresolved launch**:
A launch attempt that a crash left without a receipt. It keeps its capacity and waits for the owner.
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
The transport that connects a native worker to the main session. It carries the observations of the worker and the commands of the owner.
_Avoid_: Plugin, adapter, socket

**Session-scoped mod**:
The Claude Code plugin that a worker session loads. It lives in the session directory of the worker and holds the report tool.
_Avoid_: Extension, plugin directory, hook

**Accepted input**:
An instruction that the native program accepted. It is not yet a delivered input.
_Avoid_: Received message, queued message, receipt

**Delivered input**:
An accepted instruction that the native program carried into a cycle.
_Avoid_: Accepted input, processed message

**Permission request**:
A native request for the person to allow a call. The person answers it in the pane.
_Avoid_: Approval, tool check, dialog

**Native cycle**:
The native turn that carries one instruction. A cycle starts at the accepted instruction and ends when its turn ends.

**Measured usage**:
The token counts that the native program reported for its turns. A count that the program did not report stays missing.
_Avoid_: Estimated cost, token estimate, zero usage

**Pending event**:
An event of a worker that nobody handled yet. The status tool lists it, and the owner acknowledges it with its event id.
_Avoid_: Open event, unread event, notification
