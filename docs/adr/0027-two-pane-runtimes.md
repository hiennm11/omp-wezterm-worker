# Two pane runtimes: Herdr and WezTerm

Status: accepted. The owner chose this design on 2026-11-10.

## Context

ADR 0025 replaced WezTerm with Herdr. The extension then ran only inside a
Herdr session. The Claude Code backend refused to start, because its system
prompt is too long for one Herdr argument.

The owner runs both runtimes. Herdr is the newer one, and the extension uses
it for the OMP backend. WezTerm is the runtime of the previous work and of
the Claude Code backend. The owner lost a working setup when ADR 0025
removed WezTerm.

Two constraints follow. The extension must open a pane in either runtime.
A tool must also use the runtime that started the worker. A pane id of Herdr
such as `w4:p1` means nothing to WezTerm, and a pane id of WezTerm is a
number.

## The decision

The extension has two pane runtimes. It keeps one seam for each one:
`rt.herdr` and `rt.wezterm`.

### The selection

The config key `runtime` takes `herdr`, `wezterm` or `auto`. The default is
`auto`.

`auto` reads the environment. The variable `HERDR_ENV` with the value `1`
names Herdr. A non-empty variable `WEZTERM_PANE` names WezTerm. A process
outside both runtimes has no runtime. A spawn then gets a refusal before a
pane opens, and the reply names both runtimes and both variables.

A configured value wins over the environment. A test and a user can thus
pick one runtime.

### The runtime of a run

Every job holds the runtime that started it. The field `runtime` is part of
the job. The database keeps it in the `payload` column, which already holds
the whole job. The schema does not change and no migration runs.

A tool reads the runtime of the job and calls only that runtime. A job from a
previous version has no runtime, and the extension reports an unknown
runtime. It never guesses Herdr, because a guess could address the pane of
another runtime.

### The pane id

The pane id is a string in the job, because the id of Herdr is text. The
WezTerm functions convert the number of the reply to a string at the
boundary. They convert back before a call. The column `pane_id` keeps its
`INTEGER` type. SQLite keeps a text value in that column as text, and a test
holds that fact.

### The launch

The two runtimes take the task in different ways.

WezTerm takes the runtime and its arguments as argv, so the task is one argv
element of the launch. Herdr refuses an argument with a line break. The task
therefore goes through `agent prompt` after the agent is ready.

The extension keeps both paths. Each path closes the pane that it opened
when a later step fails.

## Consequences

A change of the pane behaviour touches two modules, `pane-herdr.ts` and
`pane-wezterm.ts`. A test of the pane layer runs against a fake of each
runtime.

The Claude Code backend stays refused on Herdr. A later change can send its
system prompt through a file, as ADR 0025 describes. The refusal then goes
away.

The extension no longer depends on one runtime. A user who runs only WezTerm
keeps the previous behaviour. A user who runs only Herdr keeps the behaviour
of ADR 0025.

ADR 0025 stays as the record of the move to Herdr. This ADR supersedes its
statement that the extension no longer uses WezTerm.
