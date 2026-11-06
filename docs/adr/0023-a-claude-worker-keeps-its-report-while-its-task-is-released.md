# A Claude worker keeps its report while its task is released

Status: accepted design. The runtime follows this contract.

## The problem

Two real runs showed that a Claude worker can finish while its owner releases
the task. The report tool said that the worker had completed, but the owner did
not get the report. The database kept the run as `running`, and its execution
row stayed `open`.

In the second run, the owner typed `/new` at 12:19:13. The log said
`session_switch released 2 task(s)`. The release closed the bridge and removed
the handover file. At 12:20:03, the worker finished its background command and
reported `completed`. The pane showed `The task state is now completed.` At
12:21:33, the owner resumed the old session and opened a new bridge. The run
still had no report in the database.

## The cause

The hook in `extensions/claude-mod/hooks/register.js` sent the report through
`observe`. That function ignored every post error. Both handlers of the report
tool returned the completion message even when the post failed.

The Codex report server writes the report file before it posts to the bridge.
The owner already reads the file through `readReports` in `restoreRunState`.
The Claude hook had no matching file writer.

## The decision

The Claude hook writes the report to the run's report file before it posts to
the bridge. The writer uses the same JSONL format as `appendReport`. The file
uses the session directory and the run id, so reports stay with their source
run.

The next owner reads the report file through `restoreRunState`. The saved
reports remain in the old run. A report does not move to a new run after the
worker resumes.

The restored state has `usage.restoredAt`. The last saved report qualifies
only when this field exists and the run has observed no cycle. The report must
also name a cycle. A report without a cycle never completes a worker.

When the worker starts a new cycle, the `cycles` list grows. The report must
then match the current cycle id. A fresh run has no `usage.restoredAt`, so it
uses the current-cycle rule from its first turn.

The hook returns the completion message when the file write succeeds. A failed
bridge post does not lose a saved report. If the file write fails, the hook
returns an error that says it did not save the report.

## Background observation loss

The report file did not preserve the end of a background command. On
2026-11-06, the owner released the task at 14:22:17 while a Claude worker ran
`sleep 90`. The release closed the bridge and removed the handover file. The
command ended at 14:22:22. Its hook posted `background.settled` to the closed
bridge and ignored the error. The worker saved its `completed` report at
14:22:32. The owner resumed the old session at 14:22:43 and found the report.
The run still stayed `running`. Its `background` execution row stayed `open`,
with job id `bevf4v66g` and no settlement evidence. A later `sleep 240` ended
after resume, and its live observation settled the row and completed the run.

The hook saves `background.started`, `background.settled` and
`background.stopped` in `.wezterm-worker-observations-<run id>.jsonl` beside
the report file. It saves each observation before it posts to the bridge. A
failed save does not stop the session. A post failure keeps its current
behavior.

`restoreRunState` loads open rows, then replays saved observations through
`observeNative`. A replay must name the restored run. Repeated settlement
observations do not settle a row twice or change the background settlement
count twice.


## Rejected options

The first rejected alternative is to block `/new` while a worker runs. This
would stop the owner from starting a new session until every worker finishes.
The worker must run without its owner session.

The second rejected alternative is to make the bridge refuse a report. The
bridge already closes during release. Refusing the report would still leave no
saved record for the owner that takes back the task.
