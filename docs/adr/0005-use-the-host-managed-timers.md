# Background polling uses the host's managed timers

The extension polls each worker's transcript on an interval. That interval is
created with the host's `ctx.setInterval`, not with the global `setInterval`.

Extensions run in-process with no isolation. A throw inside a raw timer
callback escapes the handler-dispatch try/catch, becomes a process-level
`uncaughtException`, and the host's postmortem handler tears down the whole
session. One failing poll would therefore end the user's entire OMP session,
not just the worker. The managed timer contains the failure, is `unref`'d, and
is cleared automatically on `session_shutdown`.

For the same reason the extension does no runtime work in its factory: the
host throws `ExtensionRuntimeNotInitializedError` when an action method is
called during extension load. Re-attaching workers to a restored registry
happens in the `session_start` handler instead.
