# A worker is stopped only when its pane is confirmed gone

A cancel or a timeout used to mark the worker as ended when WezTerm accepted
the close request. The pane could still be open, and the process could still
run and spend tokens. The extension now marks a worker as ended only after the
pane list shows that the pane is gone.

A pane list that fails or cannot be read means "unknown". It never means
"gone". While the pane is not confirmed gone, the worker stays active and
carries a stop failure reason. `wezterm_worker_cancel` accepts that worker
again, and the monitor retries the stop on the next poll for a timeout. The
extension adds no new `JobStatus` value, so the registry and the tools keep
their format.

The cost is that a worker with a stubborn pane stays active, and it counts
against the worker limit (ADR 0007). That is deliberate: an unconfirmed stop
that looks like a success hides a process that still runs.
