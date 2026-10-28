# Background polling uses the host's managed timers

The extension polls the transcript of each worker on an interval. The
extension creates that interval with the host's `ctx.setInterval`. The
extension does not use the global `setInterval`.

Extensions run in-process with no isolation. A throw inside a raw timer
callback leaves the handler-dispatch try/catch. The throw becomes a
process-level `uncaughtException`. The host's postmortem handler then stops
the whole session. One poll with an error would thus end the full OMP session
of the user. The poll would not end only the worker.

The managed timer contains the failure. The timer is `unref`'d. The host
clears the timer automatically on `session_shutdown`.

For the same reason the extension does no runtime work in its factory. The
host throws `ExtensionRuntimeNotInitializedError` when an action method runs
during the load of the extension. The extension re-attaches workers to a
restored registry in the `session_start` handler instead.
