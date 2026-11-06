# A session switch releases the tasks of the old session

Status: accepted design. The runtime follows this contract.

## The problem

OMP emits `session_before_switch` and `session_switch` when `/new`, `fork`
without an entry id, or `resume` moves the host to another session. It emits no
`session_shutdown` for these actions. The extension keeps the old session id,
so its monitors keep running after the host changes sessions.

## The decision

The extension does nothing at `session_before_switch`. The host can cancel
that event. The extension waits for `session_switch` to confirm the move.
The switch handler releases every running task of the old session through
`releaseSessionTasks`. It binds the new session id, gets tasks owned by the
new session, and attaches their monitors.

A task released by the old session keeps running. Its result stays with the
session that resumes and gets the task. The new session does not receive that
result.

A subagent does not release or get tasks during a switch. OMP loads the
extension for subagents in the same process. The handler must keep the main
session authority unchanged.

## The accepted risk

The host changes its session id before it emits `session_switch`. The runtime
holds the old id during that gap. A monitor can poll then. It reads the owner
row, which still names the old session, and it keeps its authority. The test
must show that this poll ends no worker.

## Rejected options

The extension could release tasks at `session_before_switch` and take them
back if the host cancels the switch. That needs a second authority change and
a recovery path for a failed takeback. The extension instead waits for the
confirmed event.

The extension could cancel a switch while a worker runs. That blocks normal
session changes and keeps supervision tied to the old session. The extension
instead releases the tasks and lets the workers continue.

In `packages/coding-agent/src/session/agent-session.ts`, `#branchIntoNewSession`
starts at line 13947. The method calls `#syncAgentSessionId()` and then
`this.#memory.rekeyForCurrentSessionId()` at lines 14022-14023. It emits
`session_branch` at lines 14029-14034. It does not emit `session_switch`.
The call at line 13935 handles `branch`. The entry-based `fork` path also
calls `#branchIntoNewSession` at line 11912. Both operations change the session id.
The branch path uses the same release, bind, acquire, and attach sequence as
the `session_switch` path. The extension handles `session_branch` because the
host emits it after changing the session id.
