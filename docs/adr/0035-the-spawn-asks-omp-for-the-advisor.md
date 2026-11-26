# The spawn asks OMP for the advisor

Status: accepted design. The runtime follows this contract.

## The problem

OMP has the flag `--advisor`. It enables the advisor runtime for one process.
The advisor reviews each turn of the worker and injects notes. The extension
did not pass the flag, so a user cannot get a review of a worker.

The user must start a worker with the advisor runtime on. The plugin must ask
OMP for it, because only OMP knows what the advisor does.

## The choices

The first choice is a parameter of the spawn tool. The user names the advisor
on the call that starts the worker.

The second choice is a key in the configuration file. The key would turn the
advisor on for every worker. The advisor costs extra tokens for every turn of
every worker, and most workers do not need a review.

The third choice is a flag of the extension. A flag of the extension changes
the behaviour of every spawn of the session. The user must ask for the
advisor on the worker that needs it.

## The choice

The first choice. The spawn tool `wezterm_spawn_worker` gets the optional
parameter `advisor`. The value `true` adds the flag `--advisor` to the argv
of the OMP worker. The default is off. A spawn without the parameter adds
nothing to the argv, so no existing worker changes.

A preset of the configuration file gets the field `advisor`. A parameter of
the call wins over the preset, also when the parameter is `false`. The
preset gives a name to a group of workers that need a review.

The plugin keeps the value in the job, next to the job field `thinking`. The
plugin stores the job as JSON in the column `payload` of the table `runs`. A
new job field needs no change in the database schema and no change in the
format of `registry.json`. A run that the database holds from before this
field existed has no value. The plugin treats a missing value as off.

The resume of a worker keeps the value of its source run, because the resume
copies the source job and builds its argv with the same function.

The Claude backend refuses the parameter before the launch. The error text
names the backend. A Claude Code worker has no advisor runtime of OMP, so the
plugin never passes the parameter to it.

The reply of the spawn tool gets one line, `advisor: on`. The line appears
only when the advisor is on. The reply says that the plugin asked for the
advisor. It does not say that the advisor runs.

## There is no global setting

There is no top-level key in the configuration file and no global setting.
The advisor costs extra tokens, because it reviews each turn of the worker.
A global switch would start a paid reviewer for every worker, including the
workers that need no review. The user asks for the advisor on the worker that
needs it. The field `advisor` of a preset names a group of workers that need
a review, so the preset does not change the setting of the user.

## What this change does not prove

This change does not prove that the advisor runs. Only OMP knows that. A test
proves that the plugin asks for the advisor and that it refuses the
parameter for a native backend.

The reply of the spawn tool names the advisor that the plugin asked for. It
does not say that the advisor reviewed a turn.
