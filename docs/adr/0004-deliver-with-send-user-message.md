# A result is delivered with sendUserMessage, not a steered sendMessage

The extension puts the result of a finished worker into the main session with
`pi.sendUserMessage(text, { triggerTurn: true })`. The call lands the text as
a user message and starts a turn. The main agent then works on the result.
The user reads nothing.

`pi.sendMessage(text, { deliverAs: "steer", triggerTurn: true })` does not
work for this. The call puts the text into the session but starts no turn.
The main agent never works on the worker.

A live probe found this fact. The probe did not read the API. The upstream
docs describe `deliverAs` for steering a *running* turn. The docs say nothing
about a message that arrives while the agent is idle.

`sendMessage` stays as the fallback for a host that does not give
`sendUserMessage`. The upstream type stub lists only `appendEntry` and
`sendUserMessage`. The options of `sendMessage` are undocumented there. A
delivery that silently does nothing is easy to miss. Check a delivery by
monitoring for a new `agent_start` in the RPC event stream. Do not compare
message timestamps.
