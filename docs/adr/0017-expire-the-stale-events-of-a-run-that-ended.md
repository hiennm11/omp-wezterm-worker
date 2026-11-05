# Expire stale events after a run ends

Status: accepted design.

## Context

A pending worker event blocks cleanup. It also appears in every status reply. An event can stay pending after its worker ends, even when no session can act on it.

## Decision

The system can expire only `missing_report`, `idle_after_working`, `execution_loss`, `thinking_stall` and `startup_blocked` events. A result holds the worker answer. The conditions `needs_input`, `permission_request`, `unresolved_launch` and `unknown_outcome` need an owner decision. They never expire.

The system expires an event only when its run is in a final state and the configured limit has passed since the later of the event creation time and the run end time. The default limit is 24 hours. The config key is `eventExpiryMs`. A value of `0` disables expiry.

Only the current owner of the task can expire its events. The owner checks events when it loads the task. A process that does not own the task writes no handling row.

The system records the disposition `expired`. The user tool `wezterm_worker_ack` does not accept this disposition. `expired` is written by the system only. The system does not delete an event row.

The system keeps pane numbers unchanged. A pane number identifies a pane and holds no state.

## Reasons

The final state proves that the worker cannot act on the event again. The condition list excludes results and owner decisions, so the system does not discard information or take a decision from the owner.

The limit allows the owner time to handle an event. The zero value lets an operator disable automatic expiry.

Ownership prevents a second session from writing handling rows for another session's task. Running expiry during task recovery uses the existing owner load path and needs no timer or new process.

The `expired` disposition distinguishes automatic expiry from an owner acknowledgement. Keeping the event row preserves the event as evidence.

Pane numbers do not encode state. Changing them would not help event handling.
