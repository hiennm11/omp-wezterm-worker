# The scripts of the repository live outside the directories that OMP scans

OMP loads every module of `tools/`, `commands/`, `rules/`, `prompts/`,
`agents/` and `hooks/` inside a plugin package as a custom tool. It imports
the module and runs it when the plugin loads. A script in one of these
directories is thus a tool. The script is a tool even if nobody meant it to
be one.

The repository keeps its scripts in `tooling/` and `scripts/`. Neither name is
a directory that OMP scans.

The scripts of this repository are not tools. The checker of the writing
standard, the trial runner and the report renderer are programs that a
developer runs from a terminal. The trial runner starts four real workers in
real panes. The trial runner ran when OMP loaded the plugin. The trial runner
left a worker in a pane. The startup then took a minute and a half instead of
four seconds.

The cost is that the repository cannot use `tools/` for a custom tool later.
A custom tool of this plugin goes into `extensions/worker-tools/`. The
extension registers it. The name of a directory then decides what the
program does. The test
`no script sits in a directory that OMP scans as a tool` holds that rule.

We rejected the alternative of a `tools/` directory with a real custom tool
in it. The scan loads every module of the directory. A single script next to
the tool would still run at load time.
