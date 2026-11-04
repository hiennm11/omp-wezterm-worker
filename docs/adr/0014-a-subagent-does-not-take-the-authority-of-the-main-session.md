# A subagent does not take the authority of the main session

OMP loads the extension again for every subagent of a session. The second
load runs in the same process. The runtime lives at module scope, so the
second load shares it.

The handler of `session_start` bound the runtime to the session of the
subagent. The main session then held no worker. The monitor of the main
session read the session of the subagent, so it stopped without a write. The
worker of the main session outlived its deadline.

The handler of `session_shutdown` had the same problem. The end of a
subagent stopped the monitors of the main session and closed the database of
the main session.

## The decision

The handler of `session_start` reads the agent of the session. OMP names the
kind of the agent in `ctx.agent.kind`. The value is `main` or `sub`.

A subagent returns at once. It binds nothing and attaches no monitor. It
replays no event. The registration of the tools stays at the factory, so a
subagent still sees the tools.

The handler of `session_shutdown` reads the same field. A subagent does
nothing. The end of a subagent must not stop the monitors of the main session
and must not close the database of the main session.

The handler of `session_start` writes one line to the logger. The line holds
the kind of the agent, the id of the agent and the session id. No log showed
those values before.

A host without the field runs a previous version of OMP. The extension treats
a missing agent as the main agent, so it keeps working there.

## Why this change and not another

The runtime stays one runtime for the process. A map of runtimes would give
every session its own runtime, but the tools and the files of the process
would then have two sources of truth. The owner chose the smaller change.

The guard sits in the entry, because the entry is the only place that knows
the events of the host. The decision itself is a pure function of the
context. It lives in `extensions/lib/subagent.ts`, so a test can check it
without a pane.

## What this change does not prove

OMP sets `ctx.agent.kind` to `sub` for the subagents that load this
extension. A fake host cannot prove that. The source of OMP builds the
agent with the kind `sub` in two cases. The first case is a session whose
task depth is above zero. The second case is a session that has a parent
task prefix. The tests of this change use the same field, so they prove the
behaviour of the extension and not the behaviour of the host.

A subagent that calls `wezterm_spawn_worker` takes the session of the
runtime, because the tool binds the session of the caller. The worker then
belongs to the subagent, and the monitor of the main session loses the
authority of its own worker. A test proves this. The behaviour is unchanged,
because a subagent that starts a worker is a case of its own.

`persist()` cannot write a wrong session into a run. The table of the runs
holds no session column. The write checks the ownership of the task, so a
session that lost the task writes nothing. A run without an ownership row
gets its first row from any session. This is the old behaviour.
