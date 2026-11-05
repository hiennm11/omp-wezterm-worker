# A closing session releases its running tasks

Status: accepted design. The runtime follows this contract.

## The problem

A restart of OMP left a worker without a supervisor. The old process kept the
task of the worker. Nobody delivered the result. The database kept the status
`running` with no result and no event.

A real run on 2026-11-05 showed the order of the events. The old process
36376 recorded the end of its session. The process stayed alive, because it
became the parent of the new process 48388. The new process wrote to the
session before the extension ran its `session_start`. The first write claims
the lease of the session, so the new process held the lease itself when the
acquisition ran.

The acquisition in `extensions/lib/owner.ts` takes the task of a live previous
process only when the answer of the lease is `false`. The answer was not
`false`. The refusal was `Process 36376 still owns the task`.

The code did not log the answer of the lease, so the reader of the log must
infer the cause from the order of the events. Nobody measured the answer on
the real run.

## The cause

The answer of the lease is not evidence that the old process is alive.

A process takes the lease of a session at the first write of that session. The
new process writes to the session before the extension runs. The new process
holds the lease itself. The answer `true` then says that a process holds the
lease. It does not say which process holds it.

The rule of ADR 0009 uses the lease as the evidence that the first owner is
gone. That rule holds while the first owner keeps the authority. It breaks
when the owner closes its session and the next process of the same session
takes the lease.

The handler of `session_shutdown` cleared the monitors and closed the
database. It did not release the ownership row. The row stayed `active`. Only
the path of a dead process or a free lease could free it.

## The change

The handler of `session_shutdown` releases the tasks that this session still
supervises. The next process of the same session takes over the running
worker through the existing path of a released row. The path of a released row
already exists, so the acquisition needs no new rule.

The release waits for the external actions that already started. The wait ends
after 1000 ms at the latest. The names of the actions that did not settle go
into the errors of the runtime, so the person sees them.

The handler always uses the same order. The handler skips a subagent. It
saves the state of the session. It releases the rows. It reports the errors.
It clears the monitors. It closes the database. Each step has its own error
handling. A step that fails does not stop the steps after it. The database
always closes last.

## The rule of the release

A row changes to the released phase only when all three conditions hold. The
session id matches. The process id and the process start time match the
closing process. The job is still active.

A row of a run that ended stays as it is. A row of another process stays as
it is. The row of another session stays as it is.

The decision is a pure function. It takes the ownership row, the job list, the
session id, the process id and the process start time. It returns the ids of
the tasks to release. A test proves it without a pane.

The release of each worker calls `releaseRunState`. The function closes the
bridge and removes the handover file. The worker keeps running. The next owner
takes over the worker.

## The status of a read-only task

The status names the answer of the lease and the process that owns the task.
The answer is `true`, `false` or `null`. The log of the acquisition names the
same answer, because the reason of a refusal must say why the task stays
read-only here.

## What this change does not prove

This change does not prove that the cause of the real run was the lease
answer. A reader of the log must infer the cause from the order of the
events. The code did not log the answer at that time.

This change does not handle a session switch. The host emits no
`session_shutdown` for `/new`, `fork` or `resume`. Issue 148 holds that work.

This change does not change the rule of ADR 0009 for two live programs that
open the same session without a close. The first owner keeps the authority
while it holds the task.
