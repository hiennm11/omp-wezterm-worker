# The ste100 skill is the only checker

Status: accepted design. The extension and the repository use the checker of the ste100 skill.

## Context

The repository held its own copy of the Simplified Technical English checker. The ste100 skill holds a newer checker. The two checkers gave different scores for the same text. A document could pass one checker and fail the other. The agents then trusted a score that the other tool did not confirm.

The repository also scored the documents of the agents and the text that the workers exchange. The copy of the checker was the only source of these scores, so the change must name a replacement first.

## Decision

The ste100 skill is the only checker of this repository. The repository keeps no copy of the checker.

The extension starts the checker of the skill with node. The checker runs in a child process. The text goes into a file of a temporary directory, and the checker reads the file. The extension removes the directory after the check.

The word list of the repository lives in `resources/ste100-dictionary.json`. The checker of the skill reads this list. The list holds the terms of the glossary of this repository, so the checker accepts the words of this project.

The setting `ste100Skill` names the folder of the skill. The default is the folder of the user. A config file can set another folder. A path that starts with `~` expands to the home folder of the user.

The command `npm run ste100` runs the checker of the skill on every document that an agent reads. The command also scores the reporting contract of a worker.

## Cost

The plugin needs the skill on the machine. A machine without the skill has no checker. The communication check then gives the verdict skipped, and the reply names the skill and its folder. The enforce mode never refuses a text when the checker does not run. The document command exits with the code 2 when the skill is not built. The command prints the steps that install the skill.
