# The extension reminds a worker that ends a cycle without a report

Status: accepted design. The runtime follows this contract.

## Context

A worker often ends its turn with prose and no call of the report tool. The
extension waited 30 seconds and then woke the main session with the condition
`missing_report`. The owner had to steer the worker by hand.

The wake of the owner is expensive. It starts a turn of the main session, and
the owner reads a transcript to find out that the worker needs a report. The
worker itself can answer that question. It holds the report tool.

The extension never sends one instruction twice. That rule covers the
steering messages of the owner. A reminder is a new instruction, so the rule
does not cover it.

## The decision

The report tick handles the condition `missing_report` before it makes an
event.

The tick sends one reminder into the pane of the worker. The text says that
the turn ended without a report. It names the tool `wezterm_worker_report`
with the state and the result. The reminder goes through the runtime seam, so
it reaches only the pane of that worker.

The reminder belongs to the cycle that received it. The job holds the
evidence id of the cycle and the time of the reminder. A second tick of the
same cycle sends nothing. A restart loads the job from the database, so a
restart sends nothing either.

After the reminder, the worker has 120 000 milliseconds to report. When no
report arrives in that period, the tick makes the event as it did before. The
owner wakes then, and the text of the wake stays as it is.

A report inside the cycle resolves the event, as it did before.

The conditions `thinking_stall` and `idle_after_working` keep their
behaviour. The delivery of a result keeps its behaviour. Prose is never a
result.

A worker with an unknown runtime gets no reminder. The extension reports the
unknown runtime as it did before, because the extension cannot name the pane
of that worker.

## The decision is a pure function

The rule that the tick applies is a function of the cycle state, the reminder
of the cycle and the clock. The function answers `nudge`, `wait` or `wake`.
A test checks the function without a pane.

The timings have names. `CYCLE_SETTLE_MS` holds the time that a cycle settles
before it needs an intervention. `MISSING_REPORT_GRACE_MS` holds the time
that the worker gets to report after the reminder.

## The contract of the worker

The reporting contract gains one sentence. The report call is the last action
of a cycle. The contract already says that a turn ends with a report. The
sentence names the rule that the extension applies.

## The tradeoffs

The reminder reaches the worker through its pane. The pane of a worker that
runs a native backend holds a native session, so the text of the reminder
does not fit a native session. The rule of this ADR covers the report tick of
an OMP worker. The native path keeps its own condition.

The reminder costs one instruction. The owner saves one turn. The wake of the
owner happens 120 000 milliseconds later than before, because the worker can
answer within that time.

The grace of the reminder is a constant. It is not a config key. A worker
that needs a different grace needs a different rule.
