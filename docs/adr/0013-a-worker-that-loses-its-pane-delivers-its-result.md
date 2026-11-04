# A worker that loses its pane delivers its result when the session takes it

A worker runs for a long time. Its pane closes, or OMP starts again. The main
session must learn that the worker ended.

The code that takes over a worker whose pane is gone ends the worker. It marks
the run as `failed` with the text "Worker pane was closed before this session
re-attached". The code did not deliver that result. The main session waited
for a worker that ended.

The replay of a start could not repair the loss. The replay runs after the
loop that takes over the workers. That loop ended the worker. The replay read
a run that was no longer active, because the run row held the status
`failed` of the old process.

The replay marked the time of the first recovery. It sent only the runs that
ended at or after that time. The worker ended before the recovery, so the
replay skipped it.

The delivery now happens in the code that takes over the worker. That code
ends the worker and delivers the result in the same step. The mark
`delivery_replay_since` keeps its meaning. A worker that ended before the
first recovery is still not delivered again.

The takeover tool uses the same code. A session that takes a task over also
delivers the result of a worker whose pane is gone. The tool still replays no
pending event.

The cause came from a copy of the state database of the user. The
database held five runs that ended with the text of the closed pane. None of
them had a delivery. The replay functions of the extension selected all three
runs of one session. The replay was never the cause. The takeover was.
