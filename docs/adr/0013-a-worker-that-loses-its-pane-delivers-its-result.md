# A worker that loses its pane delivers its result when the session takes it

A worker runs for a long time. Its pane closes, or OMP starts again. The main
session must learn that the worker ended.

The code that takes over a worker whose pane is gone ends the worker. It marks
the run as `failed` with the text "Worker pane was closed before this session
re-attached". The code did not deliver that result. The main session waited
for a worker that ended.

The replay of a start cannot repair this loss. The replay runs after the
loop that takes over the workers. That loop ends the worker first, so the
replay would have to read a run that ended in the same start.

The replay marks the time of the first recovery. It sends only the runs that
ended at or after that time. In a state directory without a mark, a worker
that ended during that first start is older than the mark, so the replay
skips it. The production database already held a mark, so this rule does not
explain the five runs of the production database.

The delivery now happens in the code that takes over the worker. That code
ends the worker and delivers the result in the same step. The mark
`delivery_replay_since` keeps its meaning. A worker that ended before the
first recovery is still not delivered again.

The takeover tool uses the same code. A session that takes a task over also
delivers the result of a worker whose pane is gone. The tool still replays no
pending event.

## What this change does not prove

The production database held five runs that ended with the text of the
closed pane. None of them had a delivery. This change fixes the path of the
attach and of the takeover. A test proves that path.

This change does not prove why those five runs had no delivery. One open
hypothesis says that a second load of the extension in the same process
changes the identity of the session in the shared runtime. Then the replay
finds no run that the session owns. Nobody tested this hypothesis. The
issue tracker holds it as a separate task.
