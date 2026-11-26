# A vacant task is claimed on demand

Status: accepted design. The runtime follows this contract.

## The problem

A finished worker keeps an ownership row in the phase active. The row names a
session that no longer runs. The current session cannot acknowledge the events
of that worker. The refusal reads: "Worker <id> belongs to session <S> (phase
active). This session only reads it."

The table of runs in `lifecycle.db` held 272 rows. Every row was completed,
failed or cancelled. The table of ownership held 254 rows. Of those, 253 were
active. Only one owner process was alive.

The rule of `controlRefusal` and `cleanupRefusal` in
`extensions/lib/authority.ts` compares the session id only. It reads neither
the state of the owner process nor the state of the run.

The rule of `releaseableJobIds` in `extensions/lib/session-release.ts` skips a
run that ended. ADR 0019, line 67, says so on purpose. So the row of an ended
run never reaches the phase released.

## The evidence

The only evidence of a dead owner is `previousOwnerState` in
`extensions/lib/owner.ts`. It reads the owner process. It returns gone, alive
or unknown. It is asynchronous, so it must not run inside `db.write`.

`takeOverOwnership` in `extensions/lib/ownership.ts` changes the owner with a
compare on the generation. The takeover tool in `extensions/worker-tools/
takeover.ts` already refuses when the owner process is alive or unknown. This
design reuses that rule.

## The choices

The first choice is a claim on demand. When a tool finds the refusal of
another session, the code reads the run and the owner process. The code takes
a vacant task. The tool goes on.

The second choice is a scan at the start of a session. The session reads every
row of the ownership table and takes the tasks that are vacant. The start of a
session then does work that no user asked for.

The third choice is to relax the refusal. Every session may act on a worker of
another session. Two sessions can then steer the same worker at the same time.

## The choice

The first choice. The claim happens only when a tool needs the task. The
session that does not need the task does no work.

The scope is narrow. Only a run that ended takes part. A run that still runs
keeps the existing path of `acquireTask`. A running worker has a live owner
in most cases, so the claim of a running run would be rare and dangerous.

The tools `wezterm_worker_ack`, `wezterm_worker_resolve`,
`wezterm_worker_cleanup` and `wezterm_worker_resume` claim a vacant task. The
tools `wezterm_worker_steer`, `wezterm_worker_cancel`,
`wezterm_worker_note_to_worker` and `wezterm_worker_notes_from_worker` keep
their refusal. A steer and a cancel reach a live worker, so a claim would
give two sessions one writer.

The rule lives in one module, `extensions/lib/vacant-task.ts`. The module
exports one function. Every tool calls it in one place.

The claim uses the generation of the row that the code read. A row that moved
since that read refuses the claim. Two claims on one generation leave one
owner.

## The lease is not used

The lease of the session is no evidence here. A process takes the lease of a
session at the first write of that session. A new process of the same session
holds the lease itself. The answer `true` then says that a process holds the
lease. It does not say that the owner of the task still runs. ADR 0019
records that limit.

The claim uses the process of the owner only. A process that cannot be read is
unknown, never gone. An unknown answer keeps the refusal that exists now.

## What this change does not prove

This change does not prove that a row of an ended run is always vacant. A
session can hold a task of an ended run and still run. The claim reads the
process of that session, so a live session keeps its task.

The change does not replay the pending events of a claimed task. A session
that claims a task reads the events with `wezterm_worker_status`.
