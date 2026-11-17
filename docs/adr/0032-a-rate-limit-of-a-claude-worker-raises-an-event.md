# A rate limit of a Claude worker raises an event

Status: accepted. The owner chose this design on 2026-11-17.

## Context

A Claude Code worker that hits the usage limit of its account cannot work.
The native program ends the turn with an error. The worker stays in its pane,
and the owner sees nothing.

The owner learns of the limit only from the transcript of the session. The
owner does not read that transcript today. The file of the session lives
outside the state directory of the plugin.

The issue 216 asked for an event. The conditions `execution_loss` and
`startup_blocked` would give the wrong meaning. Both conditions mean that the
worker is gone. A rate limit means that the worker waits.

## The decision

### The condition

The condition is `rate_limited`. The event is actionable. The run stays
`running`. The extension does not cancel the worker. The deadline of the run
stays as the net.

The owner decides. The owner cancels the worker or the owner waits for the
reset.

### The source of the error

The hook `turn.complete` of the mod carries the reason of the end of a turn.
The value is `error` for every API error. The hook names no kind of error.
The hook `session.append` carries only the fields `door`, `message`, `origin`
and `uuid`. Neither hook names the kind of the error.

The kind of the error is in the transcript of the session. The row of the
error has the type `assistant`, the field `error` with the value
`rate_limit`, the field `apiErrorStatus` with the value 429 and the field
`quotaLimits`. The field `quotaLimits` holds the time of the reset in the
field `resetsAt`. That value is an epoch in seconds. The field
`rateLimitType` names the kind of the limit, for example `five_hour`.

The mod sends the path of the transcript when a turn ends with an error. The
owner reads the tail of that file. The reader takes the last 256 KB of the
file and drops the first line of that tail, because the first line can be a
cut line. The reader never reads the whole file. The host refuses the read
of a file over 4194304 bytes. A long Claude session reaches that size.

The owner reads a file of `<home>/.claude/projects/` only. The path comes
from a token bound bridge, and the owner still resolves the path and refuses
a path that leaves that directory.

### The event

The evidence id of the event is the id of the turn. One limit gives one
event. A replay of the same turn gives no second event. The payload holds
the time of the reset in milliseconds, the kind of the limit and the status
of the API.

The event resolves when a newer turn starts. The newer turn proves that the
worker went on. The history of the event stays. The function
`resolveObsoleteEvent` writes the resolution, as the startup block does.

The event expires like the other no-action events. The run of the event must
be in a final state, and the limit of the configuration must pass.

### The text

The status tool and the wake name the reset time in a plain form, for
example `resets at 2026-11-17 14:30 (five_hour)`. The text says that the run
still runs and that the owner decides.

## The limits of this decision

The scope is the Claude backend and the error `rate_limit`. Another API
error, for example `invalid_request`, raises no event. The Codex backend is
out of scope. ADR 0026 removed that backend. No code of that backend reads a
transcript of a Claude session.

The mock of a real session gives no `quotaLimits`. The event then carries no
reset time. The unit tests cover the time of the reset.

The proof did not use the real limit of an account. The proof used a local
mock server that answered every request with the status 429. The proof did
not check the interactive mode of Claude Code, so the reason of the end of a
turn in that mode stays unknown. The design depends on the value `error`. A
probe of 2026-11-17 saw that value in the print mode.
