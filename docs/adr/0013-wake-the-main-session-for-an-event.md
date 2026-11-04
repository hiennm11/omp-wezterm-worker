# The main session wakes for an actionable event

Status: accepted design. The owner accepted it on 2026-11-04.

## Context

The monitor writes a worker event into the database. Nothing wakes the main
session. The owner learns of the event only when it calls
`wezterm_worker_status`. A worker that waits for a person therefore waits
until the owner happens to ask for the status.

ADR 0009 says that the extension delivers each event at least once. The
delivery of a result wakes the main agent. The delivery of an intervention
event did not exist.

The table `deliveries` holds the attempts of a delivery. Its column
`event_id` holds the run id for the delivery of a result. A run id as the key
of an event delivery would mark the result of that run as sent. The replay of
the result would then skip it.

## The decision

One function lifts an event and wakes the main session. It calls
`createEvent`. When the call created the event, and the event is actionable,
the function sends one message.

The function replaces the calls to `createEvent` in the monitor, in the events
of a native run, in the startup block check, and in the recovery of the launch
attempts. The creation of the event of an execution loss keeps the old path.
The stop of the worker tells the owner already.

A result never wakes the session through this path. The result has its own
delivery.

The wake uses the channel of the delivery of a result:
`pi.sendUserMessage(text, { triggerTurn: true })`. The message lands in the
session as a user message. It starts a turn.

The message is short. It names the worker id, the label of the worker, the
condition, the run time, and the event id. It names the tools
`wezterm_worker_peek`, `wezterm_worker_steer` and `wezterm_worker_ack`. It
holds no result text. It never tells the worker to continue.

Only the owner of the task of the event may wake the session. The check and
the write of the attempt run in one transaction. The delivery of a result
works the same way.

The attempt of the wake uses the event id as its key. The key of a delivery
attempt is the key of the message. The key of the message of an event is the
id of the event. The result of the run keeps its own key. The replay of a
result still delivers that result.

The attempt is written before the message goes out. The attempt moves to the
state `sent` after the message went out. A crash between the two leaves an
unsettled attempt. The startup recovery sends the message again.

## The wake happens once

A poll of the monitor runs again every second. The event that the poll found
already exists. The function `createEvent` then reports that it created
nothing. The function sends no message.

The delivery row of the event holds the state `sent` after the first wake. A
later wake for the same event sees that row. It sends no message. The
function checks that row as well. A restart cannot wake the session twice for
the same event.

The event stays in the list of the pending events. A pending actionable event
blocks `wezterm_worker_cleanup`. The wake does not record a handling. The
owner still has to acknowledge the event with `wezterm_worker_ack`.

## The replay at startup

A restart can lose the wake. The startup recovery wakes the session again for
every event that satisfies three conditions:

- the session owns the task of the event;
- no owner handled the event;
- no delivery of the event reached the main session.

The recovery skips the events of a run that ended and delivered its result.
The owner knows that run already.

The recovery runs after the recovery of the results. The recovery of the
results sends the result of a run that ended. The wake of the event of that
run would then arrive after the result. The message would name an event of a
run that the owner already knows.

## The host behaviour of a message in a turn

A live probe of the host on 2026-11-04 measured the behaviour. The probe ran
omp 18.16.0 in the RPC mode. It called `pi.sendUserMessage` while the agent
was in a turn, and it read the event stream of the host.

The upstream document `docs/extensions.md` of `oh-my-pi` names the behaviour.
The call `pi.sendUserMessage(content, { deliverAs })` submits text without
the expansion of a slash command. The upstream document says that omitting
`deliverAs` starts a prompt when the session is idle. It says that the call
queues a steer while the session streams.

The upstream source of the host agrees. The method `sendUserMessage` of the
session calls the prompt flow with the delivery mode `steer`. The method
`steer` of the agent pushes the message onto the steering queue.

The probe measured the following facts:

- A message that arrives while the agent runs lands on the steering queue.
  The host reports the queue with the event `queue_update`.
- The host delivers that message at the boundary of the turn. The event
  `turn_end` comes first. The event `turn_start` comes next. The message
  arrives as a user message with the flag `steering`.
- The message starts the next turn. The agent works on it right away.
- The message does not abort a tool that runs at that moment. The tool
  finished, and the host delivered the message afterwards.
- A message that arrives while the agent is idle starts a turn at once.

The option `triggerTurn` is not part of the options of `sendUserMessage` in
the upstream source. The type stub of the host lists it. The host accepts the
option, and the probe measured the same behaviour with the option and without
it. The option `deliverAs` decides the behaviour.

The extension passes `triggerTurn: true` and no `deliverAs`. The message
therefore starts a turn when the session is idle. It queues a steer while the
session streams. The owner sees the message at the start of the next turn.

The wake and the delivery of a result use the same channel. A message of the
delivery of a result behaves the same way.

## The tradeoffs

The wake sends a message that the owner must read. A worker that lifts many
events lifts many messages. The key of the event keeps the count low. A
repeated condition finds the event that exists.

A wake that the owner never handles stays pending. The cleanup of the worker
stays blocked until the owner acknowledges the event. ADR 0009 gives that
rule for every pending event. The wake does not change it.

The wake and the delivery of a result use the same channel. A message that
reaches the session while the session streams waits on the steering queue.
The host delivers it at the boundary of the turn. The owner sees the message
at the start of the next turn.
