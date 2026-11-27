# The main session promotes facts and the spawn injects them

Status: accepted design. The runtime does not follow this contract yet.

## The problem

A worker does not inherit the main conversation. When worker B needs a result
of worker A, the main session copies the text into the task of worker B by
hand. The worker channel (ADR 0024) gives no help, because a channel belongs
to one task and has no path between two workers.

## The choices

The first choice is a new kind of note in the channel. It stays inside one
task, so it leaves the problem open.

The second choice is one store that every worker writes and reads. A wrong
fact of one worker then reaches every other worker. Many writers also write
the same file.

The third choice is a store that only the main session controls. A worker
proposes a fact. The main session promotes it. Only a promoted fact can reach
another worker. This keeps ADR 0024: there is no path from worker to worker.

## The decision

The third choice.

A **fact** has a key, a text, a writer and a time. The key is a short name
that is unique in the store. The text holds 4000 characters at most, as a
channel note does. A new fact with an existing key replaces the older fact.
The replaced fact stays in the file.

There are two files, and each file has one writer.

- The worker writes `.wezterm-worker-facts-proposed.jsonl` in its own session
  directory. A proposed fact changes nothing for any other worker. The cleanup
  of the worker removes the file with the session directory, so there is no
  new deletion path.
- The main session writes the promoted facts to `facts/<session id>.jsonl` in
  the state directory. The session id is `rt.sessionId`. When it is null, the
  tool refuses to write. A promoted fact is a work product, so the extension
  never removes the file (ADR 0002).

The main session can retract a promoted fact. A retraction is a new line in
the same file. The first line stays. A reader ignores a retracted key.

The worker gets one new tool, `wezterm_worker_propose_fact`. The worker has
no tool to read facts. A promoted fact reaches a worker in two ways: the
snapshot at spawn, and a channel note that the main session sends.

The main session gets one new tool, `wezterm_worker_facts`, with the
parameter `action`. The actions are `list`, `set`, `promote` and `retract`.
The action `promote` copies a proposed fact of one worker. The action `set`
writes a fact that the main session names itself.

The spawn tool gets the optional parameter `facts`, a list of keys. The spawn
reads each key once and writes the texts into the file
`.wezterm-worker-facts-snapshot.md` in the session directory. The bootstrap
prompt of the worker includes that file. Both backends use the same file.
The spawn refuses the whole call when a key does not exist, when a key is
retracted, or when the texts hold more than 16000 characters in total. The
reply names the key or the size. The spawn never skips a key and never cuts a
text.

The snapshot does not change. A fact that the main session retracts later does not
leave a worker that already started. The reply of the retraction names this limit.

The job gets no new field, so the `runs` payload and the format of
`registry.json` do not change. A resume finds the snapshot file in the
session directory of its source run. The writers of the Claude contract and of
the OMP prompt read that file when it exists, so a resume keeps it.

## The consequences

- The main session stays the only path between two workers.
- A wrong fact needs a decision of the main session before it reaches another worker.
- The main session tools grow from fifteen to sixteen. The worker tools grow
  from three to four. A restricted `--tools` list of an OMP worker keeps the
  new worker tool, as it keeps the other three. A Claude Code worker needs the
  matching tool in its mod, a route in its bridge and a handler.
- The promoted file grows without a limit. A tool that clears it can come
  later without a change of this contract.
