# A Claude worker starts bare and takes its task by prompt

Status: accepted. The owner chose this design on 2026-11-18.

## Context

A Claude spawn on Herdr failed five times in a row. Four spawns reported
`timed out waiting for agent startup`. One spawn reported `agent_name_not_found`.

The cause is the argv of the launch. The launch put a task prompt at the end
of the argv of `claude`. Claude starts to work at once when it holds a prompt.
Herdr waits for the state `idle` after `herdr agent start`. Herdr can miss the
short moment of that state. It then waits until the first turn ends. A long
brief keeps the turn longer than the limit of 30 seconds.

The measurements on Herdr 0.9.5 and Claude Code 2.1.327 showed this:

- The same command with a prompt in the argv reached `idle` in 6 seconds
  three times, and it timed out three times. The version of Claude Code is
  not the cause.
- A start without a prompt reached `idle` in 6 to 9 seconds in 8 of 8 runs.
- `herdr agent prompt` after that start delivered a text with line breaks and
  tabs.
- When Herdr reported the timeout, `herdr agent list` showed the worker as
  `working`. The worker was healthy. The launch then closed the pane, so it
  killed a worker that ran.

## The decision

The launch starts Claude with no prompt in the argv. It sends the one-line
prompt with `herdr agent prompt` after the start returns.

The prompt names the task file `.claude-task.md`. The task has many lines, so
it stays in the file. The argv keeps `--add-dir <session directory>`, so the
worker can read the file.

### The proof

The OMP backend proves the delivery with the transcript in the session
directory (ADR 0030). A Claude worker writes no transcript there.

The mod of Claude Code reports `prompt.submit.ingress` to the bridge for every
prompt that the session takes. The launch uses that observation as the proof.
It looks for the one-line prompt in the text of the observation.

`awaitDelivery` takes a function that answers whether the proof exists. The
OMP backend passes the transcript check. The Claude backend passes the bridge
check. The wait, the one Enter key and the failure stay the same.

## Consequences

A Claude spawn on Herdr no longer depends on the idle detection of Herdr for a
task. The argv holds no text with a line break.

The launch fails when the bridge shows no submit. It closes the pane that it
opened, like the OMP launch.

A resume sends no task, so it keeps its argv.

WezTerm keeps its behaviour: the argv of the program holds the task.
