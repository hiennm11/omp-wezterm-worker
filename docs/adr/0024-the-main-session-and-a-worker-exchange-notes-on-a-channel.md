# The main session and a worker exchange notes on a channel

Status: accepted design. The runtime follows this contract. The push to a
worker of Claude Code was added on 2026-11-11.

## The problem

The main session and a worker could only talk through a steering message. A
steering message interrupts the worker and changes its task. The main
session had no way to give a worker a fact, or to receive a fact from a
worker, without changing what the worker does.

A worker that discovers something interesting must put it into its report. A
report carries a task state, so the fact rides in a wrong place. A main
session that wants to pass a fact to a worker must steer it. The steering
message interrupts the work and adds a turn to the transcript.

## The decision

The main session and one worker share a worker channel. A channel note is a
short piece of free text. A note changes no state of the task. A note never
steers anybody.

The scope is the main session and its own worker. There is no worker to
worker path. A channel belongs to one task, and the key of the task is the
resource group. A resume shares the session directory of its source run, so
the channel of the task survives a resume.

The storage is two JSONL files in the session directory, next to the report
file. The main session writes the file `.wezterm-worker-channel-main.jsonl`.
The worker writes the file `.wezterm-worker-channel-worker.jsonl`. Each file
has exactly one writer, so the two sides never write the same bytes. The
files follow the rule of the report store: one append per note, and a
partial line is skipped while the file is written. The cleanup of a worker
removes the session directory, so it removes the channel. There is no new
deletion path.

A note holds a number, the run that wrote it, its text and its time. The
number of a note counts the notes of its own file. A note of the worker
names its run, because a resumed run writes into the same file. A note of
the main session names no run. The text holds 4000 characters at most. An
empty note and an over-long note are refused. The total size of the channel
has no limit.

A read is stateless. The caller passes the number of the last note that it
read, and the default is 0. The reply names the highest number of the
channel. There is no read cursor on disk.

The four tools are:

- `wezterm_worker_note_to_main`, for the worker.
- `wezterm_worker_notes_from_main`, for the worker.
- `wezterm_worker_note_to_worker`, for the main session.
- `wezterm_worker_notes_from_worker`, for the main session.

A worker reads and writes only its own channel. The extension finds the
channel through the session directory of the worker and the run context. No
parameter points at another worker.

OMP filters the extension tools with the flag `--tools`. The OMP backend
adds the two worker channel tools and the report tool to each non-empty
restricted tool list that omits them, the same rule that ADR 0018 gives for
the report tool. The reporting contract names the channel tools, so a worker
that cannot call them breaks its own contract.

The main session uses the existing authority check, the same one that the
steer tool uses. Another session cannot read or write the channel of a task
that it does not own. The refusal names the session that holds the task. A
main session can write a note to a worker that does not run. The reply says
that the worker reads the note after a resume.

The communication check scores a note of the main session on the channel
`steer` and a note of the worker on the channel `result`. No new channel
exists.

There is no push for a worker of OMP. The extension never steers a worker
when a note arrives. The bootstrap prompt tells the worker to read the
channel at the start of each instruction cycle and before it reports
`completed`.

A Claude Code worker takes the note as its next prompt. The mod of the
worker submits the note with the label `Note from the main session:`. The
note reaches the worker one time, and the mod records the id of the note, so
a restart of the session never submits it again. A note that arrives while a
permission request is open waits, the same rule that a steering instruction
follows. The turn of a note is not an instruction cycle, so a note changes
no state of the task and the report rule stays the same.

The delivery of a finished worker carries the 10 newest worker notes. One
line names the older notes and the tool that reads them. The status tool
shows one count line per worker, for example `notes: 3 from worker, 1 to
worker`. It shows no note text.

A Claude Code worker has a channel. The mod of the worker reads the channel
through the bridge of the run, and it writes a note through the same bridge.
The main session uses the same four tools for every backend, so the main
session never needs to know the backend of a worker.

## The reasons

The terms are Worker channel and Channel note. The words board, message and
agent name other things in this repository, so they stay out of the name of
this feature.

The channel of a worker of OMP has no push because a push turns a note into
an interruption. The whole point of a note is that it does not change what
the worker does. The bootstrap prompt gives the worker the rule to read the
channel, and the worker reads it when it starts an instruction cycle.

A worker of Claude Code has no instruction cycle of its own. It reads the
channel only when the main session asks it to. The owner chose the push for
that backend, because a note that only waits for a cycle never reaches a
worker that waits for the main session. The push keeps the meaning of a
note, because the turn of a note is not an instruction cycle and it changes
no state of the task.

The mod of a Claude Code worker never parses a channel file. It asks the
bridge for the notes, and the bridge gives the text. The shape of a note
therefore lives in one place, and both backends read the same shape.

The id of a note is the key of a delivery. The mod records the id of every
note that it delivered, so a restart of the session never submits a note
again.

The number of a note counts the notes of its own file, because the two sides
do not write the same file. A shared counter would need a lock, and a lock
would give the two sides a reason to wait for each other.

The delivery carries the notes, because the main session reads the result of
a finished worker first. A note that the main session reads then has a
second place to look. The limit of 10 keeps the delivery short.

The count line of the status shows no note text, because a status row must
stay short. The count tells the owner that the channel holds something to
read. The owner then calls the read tool.

## Rejected options

The first rejected alternative is one file for the channel. Two writers would
need a lock, and a lock would fail when a process dies while it holds the
file.

The second rejected alternative is a database table for the channel. The
report store already keeps the evidence of a run in a file next to the
transcript. A channel belongs to the same place, and it disappears with the
session directory.

The third rejected alternative is a note cursor on disk. A cursor breaks when
two readers read the same channel, and the number of a note already names
the position.

The fourth rejected alternative is a push that wakes a worker of OMP. A push
costs a turn of the worker for a fact that the worker can read at the start
of its next instruction cycle.

The fifth rejected alternative is a push that steers the worker. A steering
message changes the task of the worker, and a note must change nothing. A
note of a worker of Claude Code reaches the worker as a prompt, and the
owner counts it as no instruction cycle.
