# A launch proves that the worker took its task

Status: accepted. The owner chose this design on 2026-11-11.

## Context

Issue 180 reported a spawn that returned "started" while the task stayed in
the composer of the pane. The task was 7 KB and 166 lines. The worker
produced no turn for 3 minutes. A person pressed Enter in the pane, and the
worker started at once.

The cause sits in the Herdr launch. `launchProgram` sends the task with
`herdr agent prompt` right after `herdr agent start` returns. There is no
wait for the OMP TUI to accept the input.

The OMP TUI renders a long multi-line text as a pasted block. The trailing
Enter of the agent prompt does not submit that block. The worker never
starts, and the tool has no evidence for its success message.

The WezTerm launch keeps its behaviour. It puts the task in the argv, so the
program takes it as one instruction. It needs no Enter key.

## The decision

A launch proves that the worker took its task before it reports a running
worker.

### The evidence

The evidence is one of two facts. The launch checks them in this order:

- a session file in the session directory of the worker that the send
  created
- a transcript that grew past the size that it had before the send

The size before the send is the baseline. A resume shares its session
directory with the run that it resumes, so the old transcript proves nothing
about the delivery of the new task.

### The wait

The launch polls the evidence every 1000 ms, at most 30 times. The poll
interval and the attempt count are a parameter of the runtime, so a test
needs no pane and no long wait.

### The Enter

When the evidence stays absent, the launch sends one key press: `herdr pane
send-keys <pane> enter`. The launch never sends the task text again. The
Enter submits the pasted block of the composer, so it is not a second
instruction. A second copy of the text would become a second instruction.

The launch then polls the evidence again with the same bound. When the
evidence is still absent, the launch fails. It closes the pane that this
launch opened and it sets the pane id of the job to null. A pane of the user
stays untouched.

### The pure check

The check of the evidence is a pure function of the session directory and of
the clock. It sits in `extensions/lib/launch-delivery.ts`. A test calls it
directly, with no pane and no process.

## Consequences

A launch without the evidence fails. The tool never reports a running worker
that never received its task. The reply of a failed launch names the reason.

A spawn of a worker whose OMP process is slow now takes longer than before.
The launch waits up to 30 s for the evidence. It sends one Enter key after
that wait. The wait ends as soon as the evidence appears.

The Claude Code backend sends its task in the argv of the program, so it
takes the same path as the WezTerm launch. The proof applies to the OMP
backend on Herdr, because only that path sends the task into a composer.

## Consequences for the tests

The fake of the Herdr CLI models the delivery. It writes a transcript into
the session directory of the worker. It writes it when the agent prompt
arrives, when the Enter key arrives, or never. The tests of the launch read
the key presses and the prompts of the fake. They see that the launch sends
the task exactly one time.

The limit of the wait is a parameter of the runtime. A test sets a short
value, so the tests of the launch do not sleep for 60 seconds.
