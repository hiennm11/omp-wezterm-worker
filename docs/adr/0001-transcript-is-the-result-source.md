# The worker transcript is the result source

A finished worker's result comes from the worker's session JSONL file. It does
not come from the text in its pane.

The command `wezterm cli get-text` returns the text that the terminal has
drawn. This text is a debug view of a live TUI. It is not a record of what the
worker produced.

The reference implementation writes a `.exit` sidecar file from a worker-side
extension. We use the transcript instead. The transcript needs no extra
component in the worker, and the transcript parsing already worked.

The consequence is that a worker which dies without writing a transcript has
no result. The extension reports this case as a startup failure after a grace
period. The extension does not treat it as an empty answer.
