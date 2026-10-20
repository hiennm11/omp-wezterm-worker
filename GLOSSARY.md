# WezTerm Pane Workers

An OMP extension that runs an independent OMP session inside a WezTerm pane or
tab, so the user watches a long task live while the main agent keeps working.

## Language

**Worker**:
An independent OMP process that runs a task in a WezTerm pane and reports one
result back. It does not inherit the main conversation.
_Avoid_: Agent, subtask, background job

**Main session**:
The OMP session that spawned the worker and receives its result.
_Avoid_: Parent session, host session

**Task**:
The self-contained instruction a worker receives. It is the worker's entire
input; the worker never sees the main conversation.
_Avoid_: Prompt, request, job

**Result**:
The final answer a worker produces, taken from the last text-only assistant
message of its transcript.
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
_Avoid_: Message, response, step

**Delivery**:
The act of putting a worker's result into the main session so the main agent
acts on it. A delivery that does not wake the agent is not a delivery.
_Avoid_: Notification, callback, push

**Registry**:
The file that records every worker, so a worker survives an OMP restart.
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
