# A Codex worker declares its background command

Status: accepted design. The owner accepted the limit that an undeclared command is not detected.

## The problem

A Codex command can outlive the turn that starts it. The app server sends no message after `turn/completed` that identifies the background command. The item field `processId` holds the id of the launcher, not the child. The extension cannot stop the child with a native signal.

The supervisor can accept a `completed` report while the command still runs. The existing execution ledger can block a completion when it holds an open background row.

## The decision

The worker declares the command with `wezterm_worker_background` before it starts the command. The declaration opens a background execution row. The worker gives the command a label. The label derives the call id, so the worker can settle the same row after it sees the result.

The worker settles the row with status `completed` or `failed`. The settlement evidence names that status. A repeated declaration with the same label does not open another row. A settlement for a label without an open row changes nothing and does not throw.

The report server approves this tool without asking the person. The tool only records the worker's execution evidence. Shell command approval stays with the person.

## The accepted limit

The owner accepts that the supervisor detects only commands that the worker declares. The extension does not inspect command text. It does not block on `unifiedExecStartup`.

A declaration without a later settlement keeps the row open until the run deadline ends the run. The extension adds no timer.

This tool exists for the Codex backend only. The Claude backend has a native signal for a background command.

## Rejected alternatives

The field `processId` does not identify the child process. It cannot prove that the background command ended.

A pid or a file condition adds a machine-specific check. It does not provide reliable settlement evidence for every command. The worker's declaration and settlement record gives the ledger the evidence that the supervisor needs.
