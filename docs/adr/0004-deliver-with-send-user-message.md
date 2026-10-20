# A result is delivered with sendUserMessage, not a steered sendMessage

A finished worker's result is put into the main session with
`pi.sendUserMessage(text, { triggerTurn: true })`. That lands the text as a
user message and starts a turn, so the main agent acts on the result without
the user having to read anything.

`pi.sendMessage(text, { deliverAs: "steer", triggerTurn: true })` does not
work for this. It injects the text into the session but starts no turn, and
the main agent never acts on the worker. This was found by a live probe, not
by reading the API: the upstream docs describe `deliverAs` for steering a
*running* turn, and they say nothing about a message that arrives while the
agent is idle.

`sendMessage` stays as the fallback for a host that does not expose
`sendUserMessage`. The upstream type stub lists only `appendEntry` and
`sendUserMessage`, so the options of `sendMessage` are undocumented there and
a delivery that silently does nothing is easy to miss. Verify a delivery by
watching for a new `agent_start` in the RPC event stream, not by comparing
message timestamps.
