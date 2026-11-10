# The spawn asks OMP for a thinking level

OMP has the flag `--thinking <level>`. The extension did not pass it. Every
worker ran at the default level of OMP, which is `high`. The user cannot
choose the level of a worker.

The spawn tool `wezterm_spawn_worker` gets the optional parameter
`thinking`. The list of levels is `off`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max` and `auto`. The plugin refuses a value outside the list before
it opens a pane.

The config file `wezterm-worker.json` gets the key `thinking`. Its default is
`null`. A null value means that the plugin asks for no level, so OMP uses its
own default. A parameter of a spawn wins over the value of the config file.

The plugin keeps the level in the job, next to the job field `tools`. The
plugin stores the job as JSON in the column `payload` of the table `runs`. A
new job field needs no change in the database schema and no change in the
format of `registry.json`.

The plugin passes the level as `--thinking <level>` in the argv of an OMP
worker. A null value adds nothing to the argv. The resume of a worker keeps
the level of its source run, because the resume copies the source job and
builds its argv with the same function.

The Claude backend refuses the parameter before the launch. The error text
names the backend. A native worker uses the thinking level of its own CLI, so
the plugin never passes the level to it.

The plugin never maps a level to another level. OMP maps a level that the
model lacks. The plugin does not repeat that work.

The reply of the spawn tool names the level that the plugin asked for. It
does not say that the worker runs at that level. The transcript of a worker
does not record the level, and OMP can lower it.

## What this change does not prove

This change does not prove that a worker runs at the requested level. Only
OMP knows the level that it used. A test proves that the plugin asks for the
level and that it refuses a wrong level.

A null value keeps the old behaviour. No existing worker changes.
