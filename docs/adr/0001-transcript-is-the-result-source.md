# The worker transcript is the result source

The result of a finished worker comes from the session JSONL file of that
worker. The result does not come from the text in its pane.

The command `wezterm cli get-text` returns the text that the terminal drew.
This text is a debug view of a live TUI. It is not a record of what the
worker produced.

The reference implementation of the worker writes a `.exit` sidecar file
from a worker-side extension. We use the transcript instead. The transcript
needs no extra component in the worker. The transcript parsing already
worked.

Because of this, a worker that dies without writing a transcript has no
result. The extension reports this case as a startup failure after a grace
period. The extension does not treat it as an empty answer.
