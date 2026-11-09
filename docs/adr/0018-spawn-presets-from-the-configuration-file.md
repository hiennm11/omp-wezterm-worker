# The configuration file holds spawn presets

The owner repeats the same worker values for scout, plan and task workers. The configuration file can now hold named sets under `presets`.
The plugin ships no set. The user chooses the model name for the machine.

The tool `wezterm_spawn_worker` has one new optional parameter, `preset`.
A set can hold only `model`, `tools`, `thinking`, `isolated` and `backend`.
A set cannot hold `placement`, `cwd`, `label`, `task` or a timeout. This keeps the set focused on worker values.

The spawn call has the highest precedence. Its values replace matching values in the set.
The set has the next precedence. Its values replace matching values in the global configuration.
The global configuration has the next precedence. Its values replace the default values.
This order lets the owner choose common values and change one value for one worker.

An unknown set refuses the spawn and lists the available names.
When the configuration has no sets, the refusal says so.
The plugin does not start a worker with default values after a spelling error.

The job holds the resolved values, not the name of the set.
The registry format does not change. The database schema does not change.
Existing job readers keep the same contract.

The OMP backend adds `wezterm_worker_report`, `wezterm_worker_note_to_main` and `wezterm_worker_notes_from_main` to each non-empty restricted tool list that omits them.
The same rule applies to a resume. An empty list stays empty.
This lets a worker report its state and use the worker channel without changing the stored job tools.

The existing backend and thinking refusals run after the set resolution.
A set cannot bypass these checks. A native backend still refuses a tools list or a thinking level.
