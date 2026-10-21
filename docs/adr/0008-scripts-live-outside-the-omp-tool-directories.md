# The scripts of the repository live outside the directories that OMP scans

OMP loads every module of `tools/`, `commands/`, `rules/`, `prompts/`,
`agents/` and `hooks/` inside a plugin package as a custom tool. It imports
the module and runs it when the plugin loads. A script in one of these
directories is therefore a tool, whether it was meant to be one or not.

The repository keeps its scripts in `tooling/` and `scripts/`. Neither name is
a directory that OMP scans.

The scripts of this repository are not tools. The checker of the writing
standard, the trial runner and the report renderer are programs that a
developer runs from a terminal. The trial runner starts four real workers in
real panes. It ran when OMP loaded the plugin, and it left a worker in a pane
and a startup that took a minute and a half instead of four seconds.

The cost is that the repository cannot use `tools/` for a custom tool later.
A custom tool of this plugin goes into `extensions/worker-tools/`, where the
extension registers it. The name of a directory then decides what the program
does, and the test `no script sits in a directory that OMP scans as a tool`
holds that rule.

The alternative, a `tools/` directory with a real custom tool in it, was
rejected: the scan loads every module of the directory, so a single script
next to it would still run at load time.
