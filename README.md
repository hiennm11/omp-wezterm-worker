# omp-wezterm-worker

Spawn an **OMP worker session inside a Herdr or WezTerm pane or tab** that runs
on its own. The user sees it live while the main agent keeps working. The main
session receives the final result of the worker automatically.

Verified against **omp 18.12.3** on **Windows native** (no WSL), Herdr
**0.9.5**. The extension runs only inside a Herdr or a WezTerm session. The
Claude Code backend starts on Herdr. It still refuses on WezTerm, and the
reply says so. See
[ADR 0027](docs/adr/0027-two-pane-runtimes.md) and [ADR 0025](docs/adr/0025-herdr-replaces-wezterm-as-the-pane-runtime.md).

## What this is (and what it is not)

Three distinct mechanisms. They are not interchangeable:

| Mechanism | What it is | Pane? | Result delivery | Where to see it |
|---|---|---|---|---|
| Native subagent (`task` tool) | In-process child OMP session | No | OMP-managed async job injection | Agent Hub (`Alt+A`), pinned Subagents block |
| **Pane worker (this plugin)** | A **separate `omp` process** in a Herdr or WezTerm pane, own model/tools/session file | **Yes** | `pi.sendUserMessage` back into the main session | The pane itself, live |
| Pane transcript view | `herdr pane read` or `wezterm cli get-text` - rendered screen text only | - | Not a result source | Read-only text dump |

This plugin creates a **real, interactive OMP TUI** in the pane. It is not a
transcript replay and not a fake TUI. The user can click into the pane and speak
to the worker directly.

## Install

You need: omp, Herdr (`herdr` on PATH), Git Bash (or any Windows bash). Start OMP inside a Herdr pane.

```bash
git clone <this-repo> D:/repos/omp-wezterm-worker
cd D:/repos/omp-wezterm-worker
"C:/Program Files/Git/bin/bash.exe" scripts/install.sh
```

The script links the repo into the OMP plugin registry (`omp plugin link`),
writes a default config to `~/.omp/agent/wezterm-worker.json`, and installs the
companion skill to `~/.omp/agent/skills/wezterm-omp-pane-ops/SKILL.md`. Start a
new OMP session and the tools are live.

> **Run the scripts from Git Bash, not WSL.** Under WSL, `omp` on PATH is the
> Linux build and the script would modify the wrong OMP installation. The
> scripts detect this and refuse to run.

Options:

| Flag | Effect |
|---|---|
| `scripts/install.sh --no-config` | Link only; do not write a config file. |
| `scripts/uninstall.sh --keep-state` | Keep the runtime state directory. |
| `scripts/uninstall.sh --keep-config` | Keep the config file. |

Environment overrides: `OMP_BIN`, `OMP_AGENT_DIR`.

## Uninstall

```bash
"C:/Program Files/Git/bin/bash.exe" scripts/uninstall.sh
```

The script removes the plugin link, the config file, the runtime state directory
and the installed skill. The script does not touch any core OMP file.

## Moving an OMP session into a project

`scripts/move-session.sh` relocates an existing OMP transcript so it belongs to
a different project directory:

```bash
"C:/Program Files/Git/bin/bash.exe" scripts/move-session.sh <session-file-or-id> <target-dir>
```

A running omp process must not own the session. You cannot move a live session
from outside. The interactive `/move` command needs a confirmation picker that a
script cannot drive.

So the script resumes the transcript in a short-lived omp process. Then the
script moves it there with the documented `SessionManager.moveTo(cwd)` path. The
transcript, its artifacts and its session id stay the same. Only the owning
project changes.

The interactive alternative, if you are in the TUI: type `/move <dir>` and
confirm the picker.

## Tools

| Tool | Purpose |
|---|---|
| `wezterm_spawn_worker` | Start a worker. Returns worker id, pane id, tab id, cwd, transcript path. Does not wait. |
| `wezterm_worker_status` | List workers, or inspect one by id. Shows lifecycle state, elapsed time, idle time, the tool running right now, turn count, steering count, the tokens used, and a pending stop. A list without an id shows every active worker, every worker with an event that waits for you, and the 10 newest workers that ended. The older workers stay hidden, and the reply names their count. |
| `wezterm_worker_ack` | Record that you handled a worker event. A delivery does not prove that you handled it. |
| `wezterm_worker_steer` | Send a new instruction into a **running** worker. It arrives as a follow-up user message and the worker keeps going. |
| `wezterm_worker_peek` | Show the last visible lines of a worker's pane. A debug aid for a worker that looks stuck. |
| `wezterm_worker_result` | Read a finished worker's final assistant text. |
| `wezterm_worker_resume` | Reopen a **finished** worker in a new pane, continuing its transcript, optionally with a follow-up instruction. The follow-up instruction is scored in Simplified Technical English, like the instruction of a steer. A low score refuses the resume before it reaches a pane. |
| `wezterm_worker_cancel` | Cancel a worker and close **only** the pane that worker created. The cancel counts only after the pane list shows the pane gone. A worker whose stop is not confirmed stays `running`, and the tool accepts it again. |
| `wezterm_worker_cleanup` | Release a finished worker's transcript directory and its isolated worktree. A worktree with uncommitted changes is kept unless `force` is set. |
| `wezterm_worker_release` | Stop the supervision of a worker and give the authority away. The worker keeps running. |
| `wezterm_worker_takeover` | Take the supervision of a worker that another session owned. The previous owner must have released the task, or its process must be confirmed gone. A live owner keeps the task. A session can take back a task that it released itself. The takeover does not replay pending events. |
| `wezterm_worker_resolve` | Settle an unknown worker outcome. It records what you confirmed. It does not create a worker completion report. The resolutions `abandoned` and `incomplete` free an unresolved launch attempt. The resolution `recorded_result` is refused for an unresolved launch. |
| `wezterm_worker_note_to_worker` | Write a short note to a worker. The note changes no state of the task, and it never steers the worker. The worker reads the note at the start of its next instruction cycle. A worker that does not run reads the note after a resume. |
| `wezterm_worker_notes_from_worker` | Read the notes that a worker wrote for the main session. The read is stateless. Pass the number of the last note that you read, or 0 for the first read. |

`/wezterm-workers` prints the roster in the TUI.

The tools `wezterm_worker_steer`, `wezterm_worker_cancel`,
`wezterm_worker_cleanup`, `wezterm_worker_resume`, `wezterm_worker_ack`,
`wezterm_worker_resolve`, `wezterm_worker_note_to_worker` and
`wezterm_worker_notes_from_worker` check the authority of the task before they
act. The delivery of a result checks it too. A session that does not hold the
authority gets one refusal that names the session that holds it. The refusal
says `Worker <id> belongs to session <S> (phase <P>). This session only reads
it.` A session without an identity and a task without an ownership row keep the
old behaviour. The automatic path of a monitor checks the authority too.

The worker reports its own task state through `wezterm_worker_report`. That
tool is worker-only. The main session never gets it.

## The worker channel

The main session and one worker share a worker channel. A channel note is a
short piece of free text, and it changes no state of the task. A note never
steers a worker, and the extension never wakes the main session for a note.

Each side writes its own file in the session directory of the worker, next to
the report file. The main session writes
`.wezterm-worker-channel-main.jsonl`, and the worker writes
`.wezterm-worker-channel-worker.jsonl`. A resume of the task shares the
session directory, so the channel survives a resume. The cleanup of a worker
removes the session directory, so it removes the channel too.

The worker writes a note with `wezterm_worker_note_to_main`. It reads the
notes of the main session with `wezterm_worker_notes_from_main`. The worker
reads the channel at the start of each instruction cycle and before it
reports `completed`.

The main session writes a note with `wezterm_worker_note_to_worker`. It reads
the notes of the worker with `wezterm_worker_notes_from_worker`. A read is
stateless. The caller passes the number of the last note that it read, and the
reply names the highest number of the channel. A note holds 4000 characters at
most, and an empty note is refused.

The delivery of a finished worker carries the 10 newest worker notes. One
line names the older notes and the tool that reads them. The status tool shows
one count line per worker, for example `notes: 3 from worker, 1 to worker`. It
shows no note text.

A Claude Code worker has no channel today. The four tools refuse with a reply
that says that the backend does not support the channel yet. See ADR 0024.


## Usage

```
Use the wezterm_spawn_worker tool with:
  task: "Read src/parser.ts and list every exported function"
  cwd: "C:\\work\\myrepo"
  label: "parser-survey"
  tools: ["read","grep","glob"]
Then keep working; the result arrives on its own.
```

### Parameters

| Name | Type | Notes |
|---|---|---|
| `task` | string | Required. Self-contained instructions. The worker sees **only** this text. |
| `cwd` | string | Absolute path. Defaults to the calling session's cwd. |
| `label` | string | Human label; shown in the pane tab title. |
| `backend` | `"omp"` \| `"claude"` | The CLI that runs the worker. Defaults to `omp`. The extension never falls back to another backend. |
| `model` | string | Optional model selector, e.g. `omniroute/minimax/MiniMax-M3.1-Flash`. Omit for omp's default. The role aliases `smol`, `task` and `slow` select a model. These aliases apply to an OMP worker only. A Claude Code worker receives the value unchanged. |
| `tools` | string[] | Optional tool list, e.g. `["read","grep","glob"]`. Omit for the default set. An OMP worker only. |
| `thinking` | string | Optional thinking level of OMP: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` or `auto`. Omit for the default level of OMP. An OMP worker only. A spawn parameter wins over the config file. |
| `placement` | `"tab"` \| `"split"` | `tab` opens a new tab and is the default; `split` splits the current pane. |
| `isolated` | boolean | Run in a dedicated `git worktree` so parallel workers never edit the same checkout. |
| `timeoutMs` | number | Deadline for this worker. `0` means **no deadline**. Defaults to the configured `timeoutMs` (30 min). |
| `closePaneOnFinish` | boolean | Close the worker's pane when it finishes. Defaults to the config value (`true`). Set `false` to leave the pane open for inspection. |

### Spawn presets

Put named presets in `wezterm-worker.json` under `presets`:

```json
{
  "presets": {
    "scout": { "model": "<your-model-id>", "tools": ["read", "grep", "glob"] },
    "plan": { "model": "<your-model-id>", "thinking": "high" },
    "task": { "model": "<your-model-id>", "isolated": true }
  }
}
```

The spawn call parameter wins over the preset. The preset wins over the global configuration. The global configuration wins over the default.
An OMP worker with a non-empty restricted tool list always gets `wezterm_worker_report`, `wezterm_worker_note_to_main` and `wezterm_worker_notes_from_main` when the list omits them. A resume applies the same rule.

### The Claude Code backend

A spawn that names `backend: "claude"` runs a real interactive Claude Code
session in the pane. The session loads a session-scoped mod that carries the
report tool and the command bridge.

| Rule | Behavior |
|---|---|
| The pane runtime | The backend starts on Herdr. It refuses on WezTerm, because the pane calls of the Claude session still use the Herdr seam. |
| The reporting contract | The launch writes the contract into the session directory and passes the path with `--append-system-prompt-file`. The text never reaches the argv of the pane, because Herdr refuses an argument with a line break. |
| The configuration of the user | The session keeps the settings, the credentials, the MCP servers and the permission rules of the user. The extension never changes a global setting. |
| The model | An omitted model uses the default of Claude Code. A named model is passed through unchanged. |
| The tool list | A spawn with `tools` and a native backend is refused before the launch. |
| The thinking level | A spawn with `thinking` and a native backend is refused before the launch. A native worker uses the thinking level of its own CLI. |
| The deadline | A native worker takes the `timeoutMs` and the `closePaneOnFinish` of its spawn, the same way an OMP worker does. |
| The report | The mod binds the report to the run id and to the native turn id. It saves each report before it posts to the bridge. A report of an earlier turn cannot finish newer work. |
| The steering | A steering instruction goes through the bridge. The native session queues it, and a running tool is not interrupted. |
| The permission | A permission request raises an event for the owner. The person answers it in the pane. A steering instruction is refused while the request is open. |

| The events | The status tool lists the events that wait for the owner. The owner acknowledges each one with its event id. The conditions are `result`, `needs_input`, `missing_report`, `thinking_stall`, `idle_after_working`, `execution_loss`, `unresolved_launch`, `unknown_outcome`, `permission_request` and `startup_blocked`. OMP raises `thinking_stall` after 600 seconds without a transcript entry. |
| The startup | A Claude worker in a new repository raises `startup_blocked`, because the session waits at the trust dialog of Claude Code. The person accepts the dialog in the pane. |
| The mod validation | The extension refuses a Claude spawn when the installed Claude Code rejects the session mod or cannot validate it. This check adds about 1.5 seconds. |
| The usage | The native CLI reports the usage of a turn when the turn ends. A run waits for the end of its turn, so the measured counts survive the end of the run. The usage of a request adds the native workers to the OMP ones. |
| The activity | A native worker writes no OMP transcript. Its activity comes from the native observations, so the idle deadline never stops a worker that is still working. |
| The resume | A resume reuses the native session id. The worker comes back with its history and a new run id. |
| The stop | The stop closes the pane of the worker only, and it confirms that the pane is gone. |

The next owner reads the saved Claude report when it restores a released run.
The report remains bound to its original run.

### The removed Codex backend

The Codex backend was removed. A spawn that names `backend: "codex"` is
refused, and the reply names the known backends. A run that the database
still holds with the backend `codex` loads as history, and every tool that
gets it replies that the Codex backend was removed. See
[ADR 0026](docs/adr/0026-the-codex-backend-is-removed.md).

### Long tasks

A worker runs for as long as it needs, until its deadline. The deadline is a
**total** limit, not a per-poll limit. The extension never stops a worker that
keeps making progress in the middle of a task.

- `timeoutMs: 0` on the spawn call removes the deadline entirely.
- The configured default is 30 minutes (`timeoutMs` in the config file).
- `idleTimeoutMs` (config file, default `0` = disabled) is a separate safety
  net: it fails a worker that produced no transcript activity for that long.
  A worker that thinks or waits for a slow tool still writes to its
  transcript, so this only fires on a genuinely stuck worker.

The main agent never blocks on a worker. It can keep working for hours while
the worker runs. The main session receives the result when the worker finishes.

Each completed or failed worker result has one actionable result event. A completed result delivery includes this line before `This request so far`:

```text
Event id: <id>. Acknowledge it with wezterm_worker_ack after you read the result.
```

The delivery wakes the main session. The result event itself is silent. Call `wezterm_worker_ack` with the event id after you read the result. Cleanup refuses while the event remains unhandled, so reading the result alone does not release the transcript or worktree.

### Expiring stale events

The owner closes no-action events after the event reaches the configured age. The expiry clock starts at the later of event creation and run end. The default limit is 24 hours. Set `eventExpiryMs` in the config file to change the limit. Set it to `0` to disable expiry. Only the current owner closes events when it loads the task. Results and events that need a decision stay pending. The system records `expired`, not `accepted`, and it does not delete the event.

### Steering a running worker

`wezterm_worker_steer` sends text into a running worker's composer and
submits it. The worker sees the same text as if the user typed it:

```
wezterm_worker_steer(workerId: "wz-...", message: "Stop surveying and focus on the parser only")
```

The worker receives it as a follow-up user message and continues from its
current state. Steering does not cancel the worker. It does not remove the
result. The main session still receives the final answer automatically.

The tool reports that fact when you steer a worker that finished already.
The tool does not send text into a dead pane.

**A steer call sends the instruction once.** The tool writes the text into
the pane and then reads the worker's transcript. The tool reports a
confirmed delivery only when the transcript records the requested text.
Any other growth of the transcript is not a confirmation. The tool reports a
delivery that the transcript does not confirm as unconfirmed. The tool never
sends the instruction a second time. A second copy of the same
instruction would reach the worker as a second instruction.

Implementation note: `herdr agent prompt` sends the text and the Enter key
in one call, so steering needs no key handling. A steering message that arrives
while the worker runs a turn waits in the queue of the worker. It does not
interrupt the turn.

### Watching a worker

`wezterm_worker_status` reports, for each worker:

| Field | Meaning |
|---|---|
| `elapsed` | Wall-clock time since the worker started, plus the deadline it will hit. |
| `idle` | Time since the worker last wrote to its transcript. A worker that is thinking or waiting on a slow tool still writes, so a growing `idle` means it is stuck. |
| `running` | The tool the worker is inside right now, when there is one. |
| `turns` | How many assistant turns the worker has taken. |
| `steers` | How many steering messages this worker took. An OMP worker counts only the instructions that its transcript confirmed. |
| `tokens` | The tokens this worker used, summed from every transcript under its session folder. A value the transcript does not hold is `unknown`, never an estimate. |
| `stop` | Shown only while a stop waits for confirmation: why the pane is not confirmed gone. Call `wezterm_worker_cancel` again to retry. |

The status tool also reports the usage of the current request. That total
covers the workers only. The tool does not count the main session.

A list without a worker id shows three groups. The first group holds every
active worker. The second group holds every worker with an event that waits
for you. The third group holds the 10 newest workers that ended. Each group
keeps the newest worker first. The other workers stay hidden, and the reply
names their count. A call with a worker id shows that one worker, even when
the worker is old.

`wezterm_worker_peek` shows the last lines rendered in the worker's pane. It
is a debug aid for a worker that looks stuck. The transcript remains the only
source of truth for the result.

The monitor reads the pane list for every active worker that has a pane id.
The pane list must confirm that the pane is gone. Then the monitor settles the
worker and frees its capacity slot. An unreadable pane list does not settle the
worker.

The status tool adds a supervision line to the row of an active worker. The
line `NOT SUPERVISED` means that this process owns the task and no monitor
watches it. The line `read-only here` means that another session or another
process holds the ownership row. That owner can be alive or gone, because the
process table cannot see the sessions of the other processes. A closed
session can leave a live process behind. Close that process, or restart OMP,
to free the task.

The line `read-only here` also names the answer of the lease of the session
and the process that owns the task. The answer is `true`, `false` or `null`.
The answer does not prove that the old owner is alive, because the new process
holds the lease itself after its first write to the session.

### A restart of OMP

A session that closes gives back the tasks that it still supervises. The
ownership rows of its running workers move to the released phase, and the
worker keeps running. The next process of the same session takes the task
over through the released row and delivers the result of the worker. The
result of a worker that ended before the close is never delivered twice.

A closing session waits at most 1000 ms for the external actions that already
started. The names of the actions that did not settle reach the log. See
[ADR 0019](docs/adr/0019-a-closing-session-releases-its-running-tasks.md).

## Session switches

The host confirms a switch after `/new`, `fork` without an entry id, or
`resume` to another session. It uses `session_branch` for `branch` and `fork`
with an entry id. Both events release the tasks of the old session, bind the
new session id, and attach tasks that the new session already owns. See
[ADR 0022](docs/adr/0022-a-session-switch-releases-the-tasks-of-the-old-session.md).

## How it works

1. `herdr pane split` (or `herdr tab create`) opens the pane. `herdr agent start`
   then runs `omp --no-title --cwd <cwd> --session-dir <job dir> [--model M] [--tools T] [--thinking L]`.
   Every value is a **separate argv element**. The extension never mixes the
   task into a shell command. So a quote cannot break the command, and nobody
   can put extra text into it. The task is not an argv element: Herdr refuses an
   argument with a line break, and a real task has line breaks. The extension
   sends the task with `herdr agent prompt` after the worker is ready.
2. The worker runs the real OMP TUI. It gets its own model, tools and session
   file. It does **not** inherit the main conversation (OMP child sessions never
   inherit history).
3. The extension polls the worker's session JSONL for a final assistant text
   block with no outstanding tool call.
4. On completion the extension sends the result with `pi.sendUserMessage`
   (`triggerTurn: true`). So the main agent starts a turn and works on the
   result without the user reading a file. See `docs/adr/0004-deliver-with-send-user-message.md`.

The worker's **session file is the source of truth** for the result. The
extension never reads the pane screen text to get a result.

## Configuration

`~/.omp/agent/wezterm-worker.json`:

```json
{
	"ompBin": "omp",
	"herdrBin": "herdr",
	"placement": "tab",
	"stateDir": "C:/Users/<you>/.omp/agent/wezterm-workers",
	"defaultCwd": "C:/Users/<you>",
	"model": null,
	"tools": null,
	"thinking": null,
	"pollMs": 2000,
	"timeoutMs": 1800000,
	"idleTimeoutMs": 0,
	"isolated": false,
	"closePaneOnFinish": true,
	"maxActiveWorkers": 3,
	"maxLaunchesPerRequest": 3,
	"commsStandard": {
		"mode": "warn",
		"minScore": 80
	},
	"ste100Skill": "~/.claude/skills/ste100"
}
```

Environment overrides:

- `OMP_WORKER_OMP_BIN`: the `omp` program that a worker runs.
- `OMP_WORKER_HERDR_BIN`: the `herdr` program that opens the pane.
- `OMP_WORKER_WEZTERM_BIN`: the `wezterm` program that opens the pane.
- `OMP_WORKER_STATE_DIR`: the folder that holds the registry and the
  transcripts.
- `OMP_WORKER_CONFIG_FILE`: the path of the config file. The default is
  `~/.omp/agent/wezterm-worker.json`. The variable applies only when the
  caller names no file. The test host names a path inside its state
  directory, so a test does not depend on the config file of the user.

The keys of the config file:

- `runtime` — the program that opens the pane of a worker. The values are
  `herdr`, `wezterm` and `auto`. The default is `auto`. The value `auto`
  reads the environment: the variable `HERDR_ENV` with the value `1` names
  Herdr, and a non-empty variable `WEZTERM_PANE` names WezTerm. A worker
  keeps the runtime that started it, so a tool that acts on that worker
  later uses the same runtime.
- `model` — the model that every worker uses. `null` uses the default of OMP.
- `tools` — the tool list that every worker gets. `null` uses the default of
  OMP.
- `thinking` — the thinking level that OMP runs every worker at. `null` uses
  the default level of OMP. The values are `off`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, `max` and `auto`. The parameter of a spawn wins over this
  value.
- `timeoutMs` — total deadline for a worker, in ms. `0` disables it.
- `idleTimeoutMs` — fail a worker that produced no transcript activity for
  this long, in ms. `0` disables it (the default).
- `pollMs` — how often the extension checks the worker transcript.
- `closePaneOnFinish` — close the worker's pane when it finishes. `true` by
  default, so a finished worker does not leave a pane behind. Set `false` to
  keep the pane open so the user can read the worker's screen.
- `maxActiveWorkers` — refuse a spawn or a resume while this many workers are
  active. The default is `3`. `0` disables the limit. The rule does not count
  the main session. A worker whose stop the extension did not confirm counts
  as active.
- `maxLaunchesPerRequest` — refuse a launch after this many launches since the
  last user prompt. The default is `3`. `0` disables the limit.
- `commsStandard` — the settings of the communication check. The section
  "The communication check" explains them.
- `ste100Skill` — the folder of the ste100 skill. The default is
  `~/.claude/skills/ste100`. The section "The communication check" explains
  the setting.
- A worker cannot launch a worker. The code refuses the call and the error
  names the rule. See `docs/adr/0007-limits-and-usage-enforced-in-code.md`.

## The communication check

The communication check scores the text that the main session and the workers
exchange. The score comes from the same Simplified Technical English checker
that scores the documents of this repository. A low score means that a reader
can read the text in more than one way.

The check reads four texts: the `task` of a spawn, the `message` of a steer, the
`message` of a resume and the `result` of a report.

The setting `commsStandard` holds the mode and the minimum score:

| Field | Values | Meaning |
|---|---|---|
| `mode` | `off`, `warn`, `enforce` | What the check does with a low score. |
| `minScore` | 0 to 100 | The score that a text must reach. A value outside the range is refused. The default of 80 is used, and the extension reports the refusal. |

| Mode | A task, a steering message or a follow-up instruction | A result |
|---|---|---|
| `off` | The check does not run. The text is sent. | The check does not run. The text is saved. |
| `warn` (default) | The text is sent, and the reply carries a warning. | The text is saved, and the reply carries a warning. |
| `enforce` | The text is refused, and the refusal names the findings. | The text is saved, and the reply carries a warning. |

The reply of every checked tool carries the score and the findings in
`details.commsCheck`. The check skips a text that is mostly Vietnamese, because
the checker cannot score it. The check skips a text when more than 5 percent of
its letters carry a Vietnamese diacritic. The check also skips a text with
fewer than three words.

The check scores a Vietnamese text that holds no diacritic as English, because
the check has no other signal.

The check starts the checker of the ste100 skill in a child process. The
skill is the only checker of this repository. The check writes the text into
a file of a temporary directory, and it removes the directory after the
check. The checker uses the word list of the skill. This repository has no word list.

The setting `ste100Skill` names the folder of the skill. The default is
`~/.claude/skills/ste100`. A path that starts with `~` expands to the home
folder of the user. A machine without the skill has no checker. The check then
gives the verdict `skipped`, and the reply names the skill and its folder.
The enforce mode never refuses a text when the checker does not run.

## Worker lifecycle

```text
spawn ──> running ──> completed ──> (pane closed) ──> resume ──> running
             │                                            ▲
             ├──> failed / cancelled ────────────────────┘
             │
             └──> OMP restarts ──> re-attached from lifecycle.db
```

**The worker reports its own task state.** The worker gets the tool
`wezterm_worker_report`. That tool is worker-only. A main session never gets
it, and a worker never gets the tools of the main session.

The worker reports `working`, `waiting`, `needs_input`, or `completed`. A
completed report carries the result of the task. The report is the only
evidence that the supervisor accepts. Answer text, pane text, and transcript
growth prove nothing.

The rule for a missing report counts one **instruction cycle**, not one
assistant message. A cycle starts at the task instruction or at a steering
input. It ends at a terminal assistant boundary. That boundary is an
assistant message that ends its turn with text and holds no tool call. A tool
result that follows the last assistant message keeps the cycle open, because
the model thinks after the result of a call. A report inside the cycle
satisfies the rule. A working report followed by a verified idle worker is a
separate condition.

**The extension reminds the worker first.** A cycle that ends without a
report gets one reminder in the pane of that worker. The text says that the
turn ended without a report, and it names the tool `wezterm_worker_report`.
The reminder goes only to the pane of that worker. One cycle gets one
reminder, and a restart sends nothing, because the reminder belongs to the
cycle in the record of the run.

The worker then has 120 000 milliseconds to report. When no report arrives in
that period, the extension raises the event `missing_report` and wakes the
main session as it did before. A report inside the cycle resolves the event.
A worker with an unknown runtime gets no reminder, because the extension
cannot name its pane. The extension reports the unknown runtime as it did
before. The conditions `thinking_stall` and `idle_after_working` keep their
behaviour. See
`docs/adr/0028-the-extension-reminds-a-worker-that-ends-a-cycle-without-a-report.md`.

The supervisor refuses a completion report while a tool call or a background
execution has no evidence of a settlement. The supervisor cannot see every
detached process, so it does not claim that it can.

**A background job settles from the transcript.** A command that runs longer
than 60 seconds moves to the background. The result of the call names the
job. The transcript holds the end of the job in one of several shapes: the
follow-up entry of the host, the result of the tool `wait`, the result of a
read of `proc://bg_N` and the result of a kill of that job. A job settles its
row when one of these shapes holds the status `completed`, `failed` or
`cancelled`. A job without such a status keeps its row open, and the blocker
names the job id and the command. See
`docs/adr/0029-the-transcript-settles-a-background-job.md`.

**The result wakes the main agent.** The extension sends the finished result
with `pi.sendUserMessage(text, { triggerTurn: true })`. The text lands in the
session as a user message and starts a new turn. The agent works on a finished
worker right away. `pi.sendMessage` with `deliverAs: "steer"` is the fallback
for a host that does not expose `sendUserMessage`.

**An actionable event wakes the main agent too.** The monitor writes the event
into the database. The extension then sends a short message with the same
channel. The message names the worker, the condition, the run time, the event
id, and the tools `wezterm_worker_peek`, `wezterm_worker_steer` and
`wezterm_worker_ack`. It holds no result text, and it never tells the worker
to continue.

The wake happens once per event. A later poll sends no second message. The
event stays in the list of the pending events, so it still blocks
`wezterm_worker_cleanup` until the owner handles it with
`wezterm_worker_ack`.

Only the owner of the task of the event may wake the session. The attempt of
the wake uses the event id as its key, so the wake never marks the result of
the run as sent. The replay of a result still delivers that result.

Two conditions never wake the session. A `result` has its own delivery. An
`execution_loss` comes with the stop of the worker, and the stop path
notifies the owner already.

A restart can lose the wake. The startup recovery wakes the session again for
every event that the session owns, that nobody handled, and that never reached
the session. The events of a run that ended and delivered its result stay out.

A wake that arrives while the main session runs waits on the steering queue of
the host. The host delivers it at the boundary of the current turn, and the
next turn works on it. A live probe of omp 18.16.0 measured that behaviour.
See `docs/adr/0016-wake-the-main-session-for-an-event.md`.

**The pane is closed when the worker finishes.** A finished worker leaves its
pane open by default, and those panes collect. `closePaneOnFinish` closes
the pane after the extension reads the result. The transcript is the result
source, and the worker stops writing once its pane is gone.

Set `closePaneOnFinish: false` per spawn or in the config to keep the pane for
inspection. That flag keeps the pane of a worker that is done. A worker that
passes its `timeoutMs` or `idleTimeoutMs` deadline still runs, so the extension
stops it. The stop counts only after the pane list shows the pane gone. See
"Cancellation safety".

**The lifecycle database holds the supervision records.** The state directory
holds `lifecycle.db`, a SQLite database through `node:sqlite`. It holds the
worker runs, the ownership, the launch attempts, the shared resources, the
execution ledger, the worker events, and the selection of the owner.

A new OMP process reads the database on startup. So `wezterm_worker_status`
lists the workers that ran when the previous process ended. The extension also
adds a monitor to each worker whose pane is still alive. The extension marks a
worker `failed` when the user closed its pane while OMP was down.

**A session takes its task back when the lease of the session is free.** A
live process does not prove that its session is open. A process can close its
session and stay alive. The lease of the session is the evidence. OMP holds a
lease for every session, and the key of the lease is the session id. A
process holds the lease of a session at the first write of that session. The
host releases the lease when the session closes, and the kernel releases it
when the process exits. So a second process that opens the same session takes
the task back when the lease is free. The first owner keeps the authority
while a process holds the lease. It also keeps the authority while the host
cannot answer about the lease. The generation of the owner moves on, so the
old owner cannot write after the takeover.

**A native worker gets a new bridge after a restart.** The new owner starts a
new bridge for the run. The new owner writes the handover file again. The
worker follows the new bridge through that file. The observations that the
worker sent while the owner was away are gone. A stored open row keeps blocking
the completion of the run until a settlement arrives or the worker stops.

**A new session can take over a task of another session.** The tool
`wezterm_worker_takeover` moves the supervision of one worker to the calling
session. The takeover needs a released task, or an owner process that the
tool confirms as gone. A live owner process keeps the task, and an unreadable
process table refuses the takeover.

**A session can take back a task that it released.** The tool
`wezterm_worker_takeover` also takes back a task of the calling session in
the phase `released`. The refusal for a task that the session still owns
applies only to the phase `active` and to the phase `releasing`. So a
released task of this session has an owner that can close the worker. The
tool `wezterm_worker_cancel` refuses such a task. Its message names
`wezterm_worker_takeover`.

**A release gives the state of the run away.** The session that releases a
task keeps no bridge and no run state of the worker. The bridge of a native
worker closes. The handover file goes too, so the worker waits for its next
owner. A closed bridge delivers no message to its handler. So no observation
of the worker reaches the session that released it. The release never stops
the worker and never closes a pane.

**A released task waits for the takeover tool.** The startup of a session
does not take the task of a released worker. The takeover tool is the way
that the owner gives a task away, so only the tool takes it. A session that
starts finds the released task read-only, and its worker stays as it is.

**The report file keeps a report that no owner held.** The bridge of a run
is the live channel of its reports. The bridge closes when the owner
releases the task, and the next owner starts a new bridge. The report file
of the session directory is the durable channel. A report that arrives while
no owner holds the task is therefore not lost. The new owner reads the
report file and the observation file when it builds the run state. The hook
saves background observations before it posts to the bridge.
The owner replays saved observations when it restores a released Claude run.
The observation file uses the run id and keeps other runs separate.

The write compares the generation that the check read. So an ownership that
moves at the same time refuses the takeover. A takeover of a finished worker
moves the ownership and starts no monitor. So the finished worker keeps its
status, its result and its error. The takeover does not replay the pending
events. The main session reads them with `wezterm_worker_status`.

**A session that does not hold the authority only reads the worker.** The
tools `wezterm_worker_steer`, `wezterm_worker_cancel`,
`wezterm_worker_cleanup` and `wezterm_worker_resume` check the ownership row
of the task before they act. A row of another session refuses the control
tools with `Worker <id> belongs to session <S> (phase <P>). This session only
reads it.` A row of this session in the phase `releasing` or `released`
refuses the control tools with a text that names the phase.

The cleanup tools accept a task that another session released, because a
released task has no owner. A session without an identity and a task without
an ownership row keep the old behaviour. So a worker from before the ownership
existed still works. The automatic path of a monitor checks the authority too.

**A monitor that lost the authority stops.** Every poll of a monitor reads the
ownership row of the task. A row of another session, or a released row of this
session, stops the monitor. Such a monitor ends no worker, writes no ledger
row and delivers nothing. A row in the phase `releasing` makes the monitor
wait, because the release can fail and give the task back to this session.

**The end and the stop of a monitor run under the operation gate.** The end of
a monitor and the stop of a monitor add their name to the list of the actions
that did not settle yet. A release that starts during such an action waits for
it. So the release cannot move the authority while a monitor still writes the
lifecycle.

Each action reads the ownership row again when it starts. The check of the
tick is not enough. The ownership can move between the check and the start of
the action. An action whose verdict is not `act` writes nothing and tells
nothing. The next tick decides again.

**A finished run stays finished in the database.** A write of a run never
changes the status of a finished run back to `queued` or `running`. So a
read-only session that keeps a stale copy of a run cannot revive it. The other
fields of a finished run still change. A closed pane and a new result stay
readable.

**Only the owner writes the row of a run.** A session writes the row of a run
only when it holds the authority of the task of that run. The startup handler
keeps every restored worker in the runtime, so a session that did not get the
authority keeps a stale copy of the run. Its write changes no row. The check
and the write run in one transaction, so a session that lost the task writes
nothing. A run without an ownership row gets its first row, and a session
without an identity writes as it did before.

The release writes the row of the run that it releases before it moves the
phase. So the next owner reads the state of the run.

**The record tools and the delivery check the same row.** The tools
`wezterm_worker_ack` and `wezterm_worker_resolve` read the ownership row of
the event task before they write. A session that does not hold the
authority writes no row, and the event stays pending for the owner. The check
and the write run in one transaction. The event names its worker, so the
worker of the parameter cannot name another task. An event without a worker
belongs to no task, so the tools run no check for it.

The delivery of a result checks the same row. A session that does not hold
the authority sends no message, writes no delivery attempt, and writes one
warning line to the log. The event stays pending for the owner that holds the
task.

**The control tools run under the operation gate.** Every action of the four
tools adds its name to a list. The list holds the actions that did not settle
yet. A release that starts during an action waits for that action. The action
reads the ownership row before it touches the pane. So a session that lost the
task never reaches the worker.

The extension moves the old `registry.json` into the database once. The file
stays on disk as evidence. The extension never writes it again, so two
processes cannot remove one another's records.

**A launch without a receipt starts no second worker.** A crash
between the pane creation and the receipt leaves a launch attempt without a
receipt. The recovery finds the live worker by its command line. The attempt
stays unresolved when the recovery does not find the worker. The attempt holds
no counted capacity. The recovery raises one `unresolved_launch` event, so the
owner finds the attempt in `wezterm_worker_status`. The owner settles it with
`wezterm_worker_resolve`. The resolution `abandoned` and the resolution
`incomplete` free the attempt. The resolution `recorded_result` is refused for
this event, because the worker of that launch never reported a result. The
extension never sends the launch command again.

**A new session leaves the attempt of another session alone.** The recovery
settles only the attempts of the tasks that this session owns. The attempt of
a task of another session stays open. The owner of that task settles it. A
takeover settles the attempts of the task that it took.

**You can resume a finished worker.** `wezterm_worker_resume` starts a new
`omp --resume <transcript>` in a fresh pane. So the worker comes back with its
whole history and can get a follow-up instruction. This is the only way
to continue a worker that completed already. Steering needs a live pane.

**The follow-up instruction of a resume is scored.** The instruction reaches a
worker, so the resume scores it in Simplified Technical English like the
instruction of a steer. The enforce mode refuses a low score before the
resume starts a pane. A resume without a message scores nothing.

**A resumed worker shares the resources of its source run.** The transcript
directory and the worktree belong to a resource group. A run finds its group
through its session directory. So a resume of a resumed run takes the group of
the first run of the task. The resume reserves the group before it reads the
baseline and before it starts a pane. A resume fails while another run holds
the group. It also fails while the previous pane of the group lives or its
health is unknown.

**A run that ends frees its resource group.** The run frees the group when
the run ends and its pane is gone. A live pane can still write into the shared
transcript, so the group stays held until that pane dies. A launch that fails
before the pane exists frees the group at once. The startup recovery frees a
group whose holder ended and whose pane is gone. A holder that is still active
keeps its group.

A resumed transcript already holds a finished turn. So the extension records
how many assistant turns the transcript had when the worker started. Only a
turn **beyond** that baseline counts as the new result. Otherwise the
extension sends the previous answer as the new one before the worker does any
work.

## Concurrency safety

### Subagents of the main session

OMP loads this extension again for every subagent of a session. The second
load runs in the same process, and the runtime lives at module scope, so the
two sessions share it. The main session sets `sendToMainSession` in its
`session_start` handler after the subagent guard. A subagent never sets this
shared channel.

A subagent must not take the authority of the main session. The handler of
`session_start` reads the agent of the session. A subagent returns at once:
it binds no session, recovers nothing, attaches no monitor and replays no
event. The handler of `session_shutdown` does the same, so the end of a
subagent never stops the monitors of the main session and never closes its
database. The tools stay registered, so a subagent still sees them.

The `session_start` handler writes one line to the log. The line names the
kind of the agent, the id of the agent and the session id:

```text
[wezterm-worker] session_start: kind=sub id=sub-1 session=...
```

A host without the field runs an older OMP. The extension treats a missing
agent as the main agent, so it keeps working there.

A subagent that calls `wezterm_spawn_worker` does not bind its session. The
worker belongs to the main session, and the main monitor keeps authority.
Result deliveries and event wakes use the shared channel of the main session.

A subagent can read worker status, pane text and results. It can start a
worker, but it cannot steer, cancel, acknowledge, release, take over, resolve,
clean up or resume a worker. Each control tool refuses before reading worker
state or accessing a pane. The refusal does not change state. See
`docs/adr/0014-a-subagent-does-not-take-the-authority-of-the-main-session.md`.

### Two workers in one checkout

Two workers that edit the same checkout are a real risk. Two options:

- **`isolated: true`** — the worker gets its own `git worktree`
  (`omp/worker/<jobId>` branch) under `stateDir/worktrees/`. You need a git repo.
  The worktree **survives the worker**: the extension does not remove it when
  the worker finishes, when the user cancels it, or when it times out. See
  "Isolated worktrees" below.
- **Limit the worker tools** — pass `tools: ["read","grep","glob"]` so the worker
  cannot write at all. Use this for survey and analysis work.

The default of `maxActiveWorkers` is `3`, so the extension refuses a fourth
worker while three are active. Use `isolated: true` for the workers that write,
so that parallel workers never edit the same checkout.

`task.isolation.enabled` in OMP's own config controls the **native** `task`
subagents only. It has no effect on these workers.

### Isolated worktrees

A worker that commits, edits or creates files produced work. The extension
keeps that work. The extension never removes a worktree on its own.

| Moment | What happens to the worktree |
|---|---|
| Worker finishes, is cancelled, or times out | Kept. The branch `omp/worker/<jobId>` and the checkout both survive. |
| `wezterm_worker_cleanup` without `force` | Kept when the checkout has uncommitted changes or untracked files. The changed paths are listed. |
| `wezterm_worker_cleanup` with `force: true` | Removed. The branch is **kept**, so commits the worker made survive. |

Cleanup checks the checkout with `git status --porcelain` before removing
anything. The tool reports a worktree with changes and does not delete it. The
changes are the worker's output. Pass `force: true` only when you plan to
discard them.

The extension never deletes the branch. Remove it yourself with
`git branch -d omp/worker/<jobId>` once you merge its content or no longer
need it.

## Failure handling

| Situation | Behaviour |
|---|---|
| `cwd` does not exist | Spawn fails immediately with `cwd does not exist: <path>`. No pane is created. |
| `omp` binary missing or not runnable | Spawn fails immediately with the underlying spawn error. No empty pane is left behind. |
| Worker dies during startup (bad model, crash) | The pane disappears with no transcript; the monitor marks the worker `failed` after a 45 s grace period and delivers the failure. |
| Worker exceeds `timeoutMs` | The extension stops the worker. When the pane list shows the pane gone, the worker is marked `failed` with a timeout message. Until then it stays `running` with a `stop` reason. |
| User closes the worker pane | The worker stays in the database; the isolated worktree (if any) is kept. |
| OMP restarts while a worker runs | The worker is re-read from `lifecycle.db` and re-monitored if its pane is still alive. A native worker also gets a new bridge, and the worker follows it through the handover file. |
| OMP restarts after the user closed the pane | The worker is marked `failed` with "Worker pane was closed before this session re-attached". A worker with a pending stop gets the status of that stop. The main session receives the result of the worker. |
| The pane list cannot be read | The pane state is unknown. It is never treated as gone. A stop stays unconfirmed, and the startup check does not fail the worker. |
| A launch breaks a limit | The spawn or the resume is refused with an error that names the rule. No worker and no pane are created. |

The extension reports every failure back into the main session. It reports a
success in the same way. So the main agent never waits on a worker that will
not finish.

**A failed poll writes its error to the logger of the host.** The extension
writes the error after the next tool result. The last errors of a session
reach the logger when the session shuts down. OMP emits no other event for
the end of a session.

## Cancellation safety

`wezterm_worker_cancel` closes **only** the pane id recorded for that worker.
It never enumerates or kills unrelated panes, and it never signals processes the
plugin did not create. The tool never touches panes of the user.

A worker ends only after the pane list shows its pane is gone. If the list
still shows the pane, or if the tool cannot read the list, the worker stays
`running` with a visible `stop` reason. Call `wezterm_worker_cancel` again to
retry. The monitor also retries on every poll. See
`docs/adr/0006-stopped-means-confirmed.md`.

## Known limitations

- You can steer a worker **while it runs** (`wezterm_worker_steer`). The tool
  `wezterm_worker_resume` continues a worker that finished already. It
  reopens the worker in a new pane from its transcript.
- The worker records are per-process in memory and stored in `lifecycle.db`. A
  worker spawned in one OMP process is visible in another through the database.
  But a **result** goes only to the process that spawned it.
- `omp --cwd` inside the home directory auto-switches to a temp directory, so a
  worker needs a real repository path.
- `isolated: true` needs a git repository. On Windows, `git worktree add` can
  fall back to a plain checkout when block cloning is unavailable.
- The extension never deletes a worktree or its branch. Worktrees collect
  under `stateDir/worktrees/` until `wezterm_worker_cleanup` runs on them.
  The repository also collects their branch names until you delete them by hand.
- The extension module loads at OMP startup. OMP does not load a new module
  with `/reload-plugins`. Restart OMP.

## The companion skill

`scripts/install.sh` installs `skills/wezterm-omp-pane-ops/SKILL.md` to
`~/.omp/agent/skills/wezterm-omp-pane-ops/SKILL.md`.

It carries the operating knowledge this README cannot state. It explains how to
send text to a Herdr pane (`herdr agent prompt` sends the text and the Enter
key together) and why a task with a line break cannot be an argv element. It
explains how to relocate a session transcript.

It also gives the Windows shell traps. One trap says that `bash` on PATH is
WSL. Another trap gives the shapes of paths. Another trap shows how you link a
plugin with a relative path. The skill is model-invoked, so an agent reaches for
it on its own when a task involves a pane or a session move.

## Repository layout

```text
omp-wezterm-worker/
├── extensions/
│   ├── wezterm-worker.ts        the entry: wires the runtime, the events and the tools
│   ├── lib/                     the worker lifecycle, with no tool schema
│   │   ├── config.ts            the config file and the defaults
│   │   ├── backend.ts           the CLI that runs a worker
│   │   ├── thinking.ts          the thinking level that OMP runs a worker at
│   │   ├── job.ts               the worker record and its run state
│   │   ├── runs.ts              the worker runs in the database
│   │   ├── transcript.ts        reading a worker's transcript
│   │   ├── calls.ts             the tool calls of a transcript, paired by id
│   │   ├── background-jobs.ts   the background jobs that a transcript names
│   │   ├── start-evidence.ts    the turn and the command that opened a row
│   │   ├── cycle.ts             the instruction cycle of a worker
│   │   ├── report-model.ts      the report that a worker sends
│   │   ├── report-store.ts      the reports of a session directory
│   │   ├── channel-model.ts     the note that travels over the worker channel
│   │   ├── channel-store.ts     the channel files of a session directory
│   │   ├── channel-select.ts    the selection of the notes of a channel
│   │   ├── channel-delivery.ts  the worker notes of a delivery
│   │   ├── report-binding.ts    the binding of a report to a run and a cycle
│   │   ├── report-decision.ts   the decision that the reports produce
│   │   ├── report-reminder.ts   the reminder for a cycle without a report
│   │   ├── usage.ts             the measured token usage of a worker
│   │   ├── runtime.ts           the shared state and the services (the test seam)
│   │   ├── process.ts           running a child process
│   │   ├── host.ts              the shape of the OMP extension API
│   │   ├── pane.ts              the panes of a worker: state, read, steer and close
│   │   ├── pane-herdr.ts        the Herdr panes
│   │   ├── pane-wezterm.ts      the WezTerm panes
│   │   ├── pane-runtime.ts      the selection of the pane runtime
│   │   ├── pane-session.ts      the guard of a pane session
│   │   ├── pane-id.ts           the pane id at the boundary of the CLI
│   │   ├── pane-launch.ts       opening a pane and starting a worker in it
│   │   ├── pane-launch-wezterm.ts opening a WezTerm pane for a worker
│   │   ├── claude-herdr.ts      the refusal of the Claude Code backend on WezTerm
│   │   ├── worktree.ts          the isolated git worktree
│   │   ├── spawn.ts             starting and resuming a worker
│   │   ├── spawn-claude.ts      starting a Claude Code worker
│   │   ├── resume-claude.ts     resuming a Claude Code worker
│   │   ├── resume-guard.ts      the pane check of the source run of a resume
│   │   ├── claude-session.ts    the Claude Code session of a worker
│   │   ├── claude-bridge.ts     the loopback bridge of a native worker
│   │   ├── claude-run-state.ts  the native state of a Claude Code run
│   │   ├── native-ledger.ts     the execution ledger of a native run
│   │   ├── native-events.ts     the events of a native run
│   │   ├── native-report.ts     the report of a native run
│   │   ├── native-usage.ts      the measured usage of a native run
│   │   ├── native-usage-report.ts the usage report of a native run
│   │   ├── restored-run.ts      the words of a restored native run
│   │   ├── bridge-handover.ts   the handover of a bridge to a new owner
│   │   ├── reattach-native.ts   the re-attachment of a native worker after a restart
│   │   ├── release-state.ts     the state of a run that a release gives away
│   │   ├── steer-native.ts      steering a worker that runs a native backend
│   │   ├── limits.ts            the launch limits and the nested-worker rule
│   │   ├── monitor.ts           watching a worker and the deadline rules
│   │   ├── monitor-authority.ts the authority of a monitor to end a worker
│   │   ├── monitor-actions.ts   the counted actions of a monitor
│   │   ├── monitor-pane.ts      the pane check of a monitor
│   │   ├── supervision.ts       the supervision line of the status tool
│   │   ├── startup-block.ts     the startup block of a native run
│   │   ├── lifecycle.ts         finishing and cancelling a worker
│   │   ├── steer.ts             steering a running worker
│   │   ├── deliver.ts           delivering a result to the main session
│   │   ├── db.ts                the lifecycle database
│   │   ├── migrate.ts           the one-time migration of the old registry
│   │   ├── ownership.ts         the ownership of a task, its release and its takeover
│   │   ├── owner.ts             the acquisition of a task by this session
│   │   ├── subagent.ts          the agent of a session, main or sub
│   │   ├── session-lease.ts     the probe of the lease of a session
│   │   ├── session-release.ts   the release of the tasks of a closing session
│   │   ├── authority.ts         the authority rules of the control and cleanup tools
│   │   ├── write-authority.ts   the authority check of a write for a task
│   │   ├── attach.ts            the supervision of a worker that this session owns
│   │   ├── attempts.ts          the launch attempts and the capacity
│   │   ├── groups.ts            the resources that two runs share
│   │   ├── group-recovery.ts    the recovery of the resource groups
│   │   ├── group-holder.ts      the holder of a resource group that ended
│   │   ├── executions.ts        the execution ledger of a run
│   │   ├── ledger-sync.ts       the sync between the transcript and the ledger
│   │   ├── events.ts            the worker events and their handling
│   │   ├── event-wake.ts        the wake of the main session for an actionable event
│   │   ├── status-list.ts       the list of workers that the status tool shows
│   │   ├── resolution.ts        the owner resolution of an unknown outcome
│   │   ├── delivery.ts          the delivery attempts of a pending event
│   │   ├── stop-intent.ts       the stop intents of a run
│   │   ├── stop-reconcile.ts    the reconciliation of the pending stop intents
│   │   ├── recovery.ts          the recovery of the stored records
│   │   ├── recover-task.ts      the replay of a result that a restart lost
│   │   ├── correlation.ts       finding a live worker by its command line
│   │   ├── process-table.ts     reading the process table and the start time of a process
│   │   ├── role.ts              the role of a process, main or worker
│   │   ├── bootstrap-prompt.ts  the reporting contract of a worker
│   │   ├── comms-check.ts       the communication check of the exchanged text
│   │   ├── worker-context.ts    the run context of a worker
│   │   └── worker-bootstrap.ts  the tools of a worker process
│   ├── claude-mod/              the session-scoped mod of a Claude Code worker
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json      the manifest of the mod
│   │   └── hooks/
│   │       └── register.js      the report tool and the command bridge
│   └── worker-tools/            one module for each tool
│       ├── kit.ts               the shared reply and the worker lookup
│       ├── spawn.ts, status.ts, steer.ts, peek.ts
│       ├── result.ts, resume.ts, cancel.ts, cleanup.ts
│       ├── report.ts, ack.ts, release.ts, resolve.ts
│       ├── takeover.ts          the takeover of a task of another session
│       ├── note-to-main.ts      the note of a worker for the main session
│       ├── notes-from-main.ts   the notes of the main session for a worker
│       ├── note-to-worker.ts    the note of the main session for a worker
│       ├── notes-from-worker.ts the notes of a worker for the main session
│       └── roster.ts            the /wezterm-workers command
├── scripts/
│   ├── _paths.sh                shared Windows-path helpers
│   ├── install.sh               link the plugin + write the config + install the skill
│   ├── uninstall.sh             unlink + remove the config, state and skill
│   ├── move-session.sh          relocate an OMP session into a project
│   ├── move-session.ts          the move helper extension it loads
│   └── mixed-mutation.ts         the mutation check of the tests of the mixed backends
├── skills/
│   └── wezterm-omp-pane-ops/
│       └── SKILL.md             operating knowledge for the model
├── tooling/
│   ├── ste100-docs.ts           the document check of the skill
│   ├── trial.ts                 the Windows trial runner
│   ├── trial-report.ts          the text of the trial report
│   ├── trial-paths.ts           the paths that the report hides
│   ├── trial-scenarios.ts       the four scenarios of the trial
│   ├── trial-scenario.ts        the helpers of the scenarios
│   ├── trial-tasks.ts           the task texts of the trial
│   ├── trial-fixture.ts         the repository that the trial workers use
│   ├── backend-proof.ts         the compatibility probe of the native backends
│   ├── backend-proof/           the modules of the probe
│   ├── claude-smoke.ts          the smoke test of the Claude Code backend
│   ├── claude-smoke-env.ts      the environment of the smoke test of Claude Code
│   ├── claude-smoke-home.ts     the home folder of Claude Code and its sessions
│   ├── claude-smoke-ledger.ts   the state of a worker of the smoke test
│   ├── claude-smoke-machine.ts  the panes and the processes of the machine
│   ├── claude-smoke-pane.ts     the startup questions of a session of Claude Code
│   ├── claude-smoke-processes.ts the processes of the smoke test of Claude Code
│   ├── claude-smoke-shared.ts   the state that the steps of the smoke test share
│   ├── claude-smoke-steps.ts    the decisions of the smoke test of Claude Code
│   ├── claude-smoke-steps-one.ts the spawn, the report and the usage
│   ├── claude-smoke-steps-refusal.ts the refusals and the default model
│   ├── claude-smoke-steps-two.ts the resume and the steering instruction
│   ├── claude-smoke-steps-three.ts the cancel and the history of Claude Code
│   └── eval/                     the worker eval: the dataset, the plan and the records
│       ├── cli.ts                the arguments, the dispatch and the exit codes
│       ├── types.ts              the dataset, the plan and the record types
│       ├── dataset.ts            the scan, the validation and the checksum of the dataset
│       ├── planner.ts            the matrix, the run count and the pilot selection
│       ├── verifier.ts           the command, the exit code and the deadline
│       ├── acceptance.ts         the acceptance verdict and the protected path restore
│       ├── artifact.ts           the JSON write, the JSON read and the resume
│       ├── environment.ts        the version of node and of the programs of the machine
│       ├── runner.ts             one experiment through the test host
│       ├── runner-host.ts        the seam that reads the results of the worker tools
│       ├── run-command.ts        the command that runs the plan of a run
│       ├── report.ts             the cells of the records of a run
│       ├── recommend.ts          the eligibility and the ranking of the cells
│       ├── format.ts             the table and the summary of a run
│       ├── report-command.ts     the commands report and recommend
│       └── datasets/             the tasks of the benchmark
├── tests/
│   ├── harness.ts               a test host for the extension
│   ├── fixtures/                the real texts that the tests read
│   ├── transcript.test.ts       reading a transcript
│   ├── config.test.ts           the config file
│   ├── registry.test.ts         the registry file
│   ├── run-authority.test.ts    the authority of a write of a run
│   ├── stop.test.ts             a stop that waits for the pane to close
│   ├── stop-reconcile.test.ts   the reconciliation of the pending stop intents
│   ├── stop-intent-gate.test.ts the gate of a pending stop intent
│   ├── limits.test.ts           the launch limits
│   ├── usage.test.ts            the measured token usage
│   ├── monitor.test.ts          the timeout, the idle limit and the result rule
│   ├── monitor-authority.test.ts the authority of a monitor to end a worker
│   ├── monitor-actions.test.ts  the counted actions of a monitor
│   ├── monitor-pane-gone.test.ts the pane check of a monitor
│   ├── supervision.test.ts      the supervision line of the status tool
│   ├── architecture.test.ts     the size, import and runtime rules
│   ├── ste100-docs.test.ts      the document check of the skill
│   ├── comms-check.test.ts      the communication check of the skill
│   ├── trial-report.test.ts     the text of the Windows trial report
│   ├── trial-paths.test.ts      the paths that the report hides
│   ├── registration.test.ts     the tools that the extension registers
│   ├── worker-channel.test.ts   the channel tools of the main session and the worker
│   ├── worker-channel-delivery.test.ts the notes in the delivery and in the status
│   ├── worker-channel-helpers.ts the helpers of the tests of the channel
│   ├── error-drain.test.ts      the report of the errors at the end of a session
│   ├── backend.test.ts          the backend of a run and the report binding
│   ├── legacy-codex-run.test.ts a run of the removed backend and its refusals
│   ├── codex-config.test.ts     a config file of the removed backend
│   ├── claude-run-state.test.ts the native state of a Claude Code run
│   ├── spawn-backend.test.ts    the refusals of a spawn with a native backend
│   ├── native-usage.test.ts     the measured usage of a native run
│   ├── correlation.test.ts      finding a native worker in the process table
│   ├── pending-events.test.ts   the events that wait for the owner
│   ├── unresolved-launch.test.ts the event of an unresolved launch and its resolution
│   ├── unresolved-launch-helpers.ts the helpers of the tests of an unresolved launch
│   ├── bridge-handover.test.ts  the handover of a bridge to a new owner
│   ├── process-probe.test.ts    the probe of the start time of a process
│   ├── ledger-sync.test.ts      the execution ledger of a run
│   ├── native-ledger.test.ts    the execution ledger of a native run
│   ├── native-snapshot.test.ts  the run snapshot of a native worker
│   ├── native-background.test.ts the background tasks of a native run
│   ├── claude-mod-background.test.ts the background tasks of the Claude Code mod
│   ├── claude-mod-snapshot.test.ts the run snapshot of the Claude Code mod
│   ├── monitor-native.test.ts   the monitor of a native worker and its outstanding rows
│   ├── startup-block.test.ts    the startup block of a native worker
│   ├── startup-block-monitor.test.ts the startup block in the monitor and in the status
│   ├── wait-result.test.ts      the settlement of a background job that a wait result names
│   ├── background-job-settlement.test.ts the settlement of a background job in every shape
│   ├── report-poll.test.ts      the report poll and the outstanding executions
│   ├── report-reminder.test.ts  the reminder for a cycle without a report
│   ├── report-reminder-helpers.ts the helpers of the tests of the reminder
│   ├── status-blocker.test.ts   the completion blocker in the status tool
│   ├── status-list.test.ts      the list of workers that the status tool shows
│   ├── resume-comms.test.ts     the communication check of the resume tool
│   ├── takeover.test.ts         the takeover of a task of another session
│   ├── takeover-process.test.ts the process record of the new owner of a task
│   ├── takeover-helpers.ts      the helpers of the takeover tests
│   ├── reattach-native.test.ts  the re-attachment of a native worker after a restart
│   ├── reattach-native-stop.test.ts the stop of a native worker whose re-attachment fails
│   ├── reattach-native-helpers.ts the helpers of the re-attachment tests
│   ├── restored-run.test.ts    the usage of a native run that a restart restored
│   ├── restored-run-text.test.ts the texts of a restored native run
│   ├── recover-task.test.ts    the replay of a result that a restart lost
│   ├── restart-delivery.test.ts the delivery of a worker that lost its pane
│   ├── group-release.test.ts    the release of a resource group
│   ├── group-holder.test.ts     the holder of a resource group that ended
│   ├── group-holder-helpers.ts  the helpers of the group holder tests
│   ├── group-recovery-panes.test.ts the recovery of a group whose pane is gone
│   ├── group-lookup.test.ts     the group of a run through its session directory
│   ├── resume-pane.test.ts      the pane of the source run of a resume
│   ├── resume-group.test.ts     the group of a resume and of a resumed run
│   ├── cleanup-group.test.ts    the cleanup of a resumed run
│   ├── cleanup-native.test.ts   the cleanup of a native run
│   ├── native-run-helpers.ts    the helpers of the tests of a native run
│   ├── authority.test.ts       the authority rules of the control and cleanup tools
│   ├── authority-tools.test.ts the authority check of the four control tools
│   ├── authority-record.test.ts the authority check of the record tools and of the delivery
│   ├── ack-native.test.ts       the acknowledgement of an event of a native run
│   ├── mixed-capacity.test.ts  the shared pool of the active workers of three backends
│   ├── mixed-request.test.ts   the count of the launches of one request
│   ├── mixed-queue.test.ts     the instruction queue of each native worker
│   ├── mixed-approval.test.ts  the approval of each native worker
│   ├── mixed-events.test.ts    the events of three backends and their acknowledgement
│   ├── mixed-recovery.test.ts  the recovery of three backends after a restart
│   ├── mixed-stop-intent.test.ts the stop intent of a native worker
│   ├── mixed-resume.test.ts    the resume of a Claude Code worker
│   ├── mixed-resource.test.ts  the resource exclusion of workers of three backends
│   ├── mixed-cancel.test.ts    the cancel of a worker of one backend
│   ├── mixed-cleanup.test.ts   the cleanup of a run with a pending event
│   ├── mixed-helpers.ts        the helpers of the tests of the mixed backends
│   ├── mixed-machine.ts        the fake machine of the tests of the mixed backends
│   ├── worker.integration.test.ts    a real worker in a real pane
│   ├── nested.integration.test.ts    the launch limits with a real worker
│   ├── worktree.integration.test.ts  the worktree of a real worker
│   ├── native-worktree.integration.test.ts  the worktree of a real native worker
│   ├── eval-dataset.test.ts      the checksum and the validation of the dataset
│   ├── eval-runner.test.ts       the runner of one experiment through a fake host
│   └── eval-planner.test.ts      the matrix, the pilot and the refusals
├── docs/
│   ├── adr/                     the decisions and their reasons
│   ├── trials/                  the record of the Windows trials
│   ├── plans/                   the proposed implementation plans
│   └── backend-proof-evidence.md  what the compatibility probe observed
├── config/
│   └── wezterm-worker.example.json
├── AGENTS.md                    the rules for work in this repository
├── GLOSSARY.md                  the terms of this domain
├── biome.json                   the lint and format rules
├── package.json                 the scripts and the omp/pi manifest
└── README.md
```

## Development

The commands need Node 22 or later. Node reads the TypeScript files directly,
so the suite needs no build step and no test framework.

| Command | What it does |
|---|---|
| `npm test` | Run every test. The integration tests spawn a real worker in a real pane. |
| `npm run test:unit` | Run only the tests that need no worker. They run one file at a time. |
| `npm run test:integration` | Run only the tests that spawn a real worker. |
| `npm run test:integration:panes` | Run only the integration tests that read the pane list. They run one at a time. |
| `npm run test:integration:free` | Run the integration tests that do not read the pane list. They run one file at a time. |
| `npm run lint` | Check the format and the lint rules. |
| `npm run lint:fix` | Apply the fixes that Biome can apply. |
| `npm run ste100` | Score every agent-facing document with the checker of the ste100 skill. The score must reach 80. |
| `npm run trial` | Run the Windows trial with real workers. It writes `docs/trials/windows-trial.md`. |
| `npm run proof:claude` | Run the compatibility probe against a real Claude Code session. It needs an evidence directory. |
| `npm run smoke:claude` | Run the smoke test of the Claude Code backend. It starts a real session, reports, resumes, steers and cancels. It closes only the panes and the processes that it created. |
| `npm run typecheck` | Type check the extension, the tools and the tests. |
| `npm run check` | Run the lint, the type check, the scores and the tests. |

The integration tests need `omp` and `herdr` on PATH, and a Herdr session
(`HERDR_ENV=1`). Run them in a throwaway session with `HERDR_SOCKET_PATH` set
to that session, so that a test never touches the panes of your own session.
Without them the tests report that they cannot run. They never report a pass
they did not observe.

Every test file runs one at a time. A test that counts the panes would see the
panes of the other test. A check also starts real workers and real panes, so
two checks that run at the same time load the machine twice. Run one check
at a time.

### The essential tests

Each test prevents the loss of one behaviour. A change that breaks a behaviour
breaks a test.

| Test | The behaviour it protects |
|---|---|
| `transcript.test.ts` | A preamble is not the result. A new user message resets the counts. A resumed worker reports only a turn beyond its baseline. |
| `config.test.ts` | The environment wins over the file. A value of the wrong type leaves the default. A malformed file leaves the defaults. A nonzero idle deadline is refused with guidance. A score outside the range is refused with guidance. The settings function refuses a score outside the range. The settings function keeps a wrong mode and a wrong score type. Two problems in one file give both guidance messages. |
| `registry.test.ts` | A running worker with a pane comes back as alive. A job of the wrong shape does not break the load. The write is atomic. |
| `run-authority.test.ts` | A session that does not hold the authority keeps the row of the owner. A run without an ownership row gets its first row. A session without an identity writes the row of the run. A run of a task that another session released gets no row. The release writes the row of the run that it releases. |
| `stop.test.ts` | A cancel ends a worker only when the pane list shows the pane gone. An unreadable pane list does not count as a closed pane. An unconfirmed stop leaves the worker running, and a retry ends it. |
| `stop-reconcile.test.ts` | The verdict follows the pane state and never guesses. A pending intent is confirmed when its pane is gone. A run without a pane counts as gone. A pending intent fails when its pane still exists. A pending intent stays pending when the pane list cannot be read. The reconciliation leaves the intent of another session alone. A pending intent refuses the action and a settled intent does not. |
| `stop-intent-gate.test.ts` | The cleanup refuses a run with a pending stop intent and goes on after the confirmation. The status shows the pending stop intent of a run. |
| `steer.test.ts` | A steer call sends the instruction once. The transcript confirms the delivery. An unrelated message does not confirm it. An old message with the same text does not confirm it. An unconfirmed delivery is not sent again. |
| `monitor.test.ts` | A worker with no deadline never times out. An active worker still times out at the total deadline. A worker that keeps writing is not stopped as idle. A resumed worker does not report its old answer. |
| `monitor-authority.test.ts` | The verdict follows the owner, the session and the phase. The monitor of the owner ends an overdue worker. A released task stops its monitor and leaves the worker alone. A task that another session took stops the monitor of the old session. The releasing phase makes the monitor wait and does not stop it. A native monitor stops when the task is released. |
| `monitor-actions.test.ts` | The release of the owner waits for the action of the monitor. An action that starts after the owner changed writes nothing. |
| `monitor-pane-gone.test.ts` | A worker with a transcript and a gone pane leaves the active set on a tick. An unreadable pane list does not settle the worker. A finished worker is not read and not changed by the pane check. |
| `supervision.test.ts` | An active task that this process owns and no monitor watches shows `NOT SUPERVISED`. An active task that another session or process owns shows `read-only here` with the session and the process. A read-only row names the answer of the lease and the process id. A watched task, a finished worker and a missing ownership row show no line. The status tool prints the line. |
| `architecture.test.ts` | No source file exceeds 350 lines. The `lib/` folder never imports the entry or `worker-tools/`. Only `lib/process.ts` starts a child process. Only the entry creates the runtime. |
| `limits.test.ts` | One active worker blocks a launch at the default limit. A worker with an unconfirmed stop still counts. A launch that failed before its pane existed does not count. A worker session cannot launch a worker. A user prompt resets the request count. |
| `usage.test.ts` | A number comes only from a transcript. A model call without usage makes the count partial. A transcript without usage shows unknown. A resumed worker counts only what came after the resume. The request total adds the workers of the request. |
| `nested.integration.test.ts` | A real worker cannot launch a worker and opens no pane. A second spawn is refused while one worker is active. |
| `ste100-docs.test.ts` | The document check gives every document and the reporting contract to the checker of the skill. The check fails with the code 2 when the skill is not built. |
| `comms-check.test.ts` | A text that scores 80 or more passes. A low score warns in the warn mode and fails in the enforce mode. The checker runs with node on a file that holds the text. A missing skill gives the verdict skipped with a note. A Vietnamese text, a short text and the off mode never start the checker. |
| `claude-argv.test.ts` | A new Claude Code worker and a resumed one both get the path of the contract file. The contract never goes into the argv as text. The task stays the last argument. |
| `claude-contract-file.test.ts` | The contract file holds the reporting contract and the same bytes for every run. A spawn on Herdr gives the program the path of the contract file. A resume writes its own contract file. |
| `worker.integration.test.ts` | A real worker completes. The result is delivered. The pane closes. The registry survives a new process. A resumed worker answers the new message. |
| `worktree.integration.test.ts` | The worktree survives the worker. Cleanup keeps a worktree with changes. Cleanup with force removes it, and the branch survives. |
| `result.integration.test.ts` | The result tool returns the answer of a finished worker. |
| `live-worker.integration.test.ts` | A running worker can be steered, peeked at and cancelled. A steering message reaches the worker. A cancel closes only the pane that the extension created. A worker past its deadline is stopped and its pane is confirmed closed. A session releases the worker that it started, and the worker keeps running. |
| `restart-adoption.integration.test.ts` | A new OMP process adopts the worker of a closed session. |
| `owner.test.ts` | A session that starts a worker owns it. A session without an identity acquires nothing. The same session acquires its task again after a restart only when the old process is gone. A second live process of the same session does not take the task. A reused process id does not count as the old owner. An unreadable process table refuses the acquisition. Another session never takes a task. A released task of another session waits for an explicit takeover. A session takes its task back when the lease of the session is free. A session keeps its task while a process holds the lease. A session keeps its task while the host cannot answer about the lease. Another session takes no task even when the lease is free. A stale owner of the same session cannot write after the second process took the task. A new process takes the task of a closed session while it holds the lease. |
| `session-lease.test.ts` | The probe reports that a process holds the lease. The probe reports that the lease is free. The probe awaits a promise of the host. The probe gives no answer when the host has no lease API. The probe gives no answer when the lease function is missing. The probe gives no answer when the call throws. The probe gives no answer when the call rejects. The probe gives no answer for a value that is not a boolean. |
| `session-release.test.ts` | A running job of this process is released. A queued job of this process is released. A row of an ended run stays as it is. A row of another session stays as it is. A row of another process stays as it is. A row of another incarnation of this process stays as it is. A row that is not active stays as it is. A job without an ownership row stays as it is. A session without an identity releases nothing. |
| `session-shutdown-release.test.ts` | A closing session releases the running worker and keeps the ended run. A closing session clears the monitors and closes the database. The shutdown of a subagent releases no task of the main session. A new process of the same session adopts the worker of a closed session. |
| `process-probe.test.ts` | The probe reads the start time of a live process. Two reads of one process give the same start time. The probe reports a gone process as gone. |
| `trial-report.test.ts` | The report names a failing check. A check detail stays on one line. The report holds no path of the machine. |
| `trial-paths.test.ts` | A path under the project becomes a relative path. A path outside it becomes a placeholder. The name of the user never appears. |
| `registration.test.ts` | The extension registers the eight tools that the agent needs. It registers the roster command. |
| `error-drain.test.ts` | The errors of a session reach the logger when the session shuts down. The extension registers no handler for `session_end`, because OMP emits no such event. |
| `backend.test.ts` | A run without a backend field is an OMP run. A run of the removed backend keeps its value. The removed backend is not a backend that a spawn may name. A report of an earlier cycle cannot finish newer work. |
| `legacy-codex-run.test.ts` | A run with the backend codex still loads from the database. A run of the removed backend that was active loads as an ended run. The status tool lists it as an ended run. A resume, a steer and a cancel refuse it. The run never looks like a run of OMP. |
| `codex-config.test.ts` | A config file with codexBin gives guidance that names the key. A config file with a codex section gives guidance that names the key. A config file with both gives one guidance line. A config file without them gives no guidance. |
| `claude-run-state.test.ts` | A native turn starts the cycle. A call settles only when the same call settles. A failed call leaves the open calls and the completion blocker. A failed call closes its permission request. A permission request holds the completion. An accepted instruction blocks the completion until its cycle carries it. |
| `spawn-backend.test.ts` | A spawn with an unknown backend is refused. A spawn with the backend codex is refused and the reply lists the known backends. A spawn with a tool list and a native backend is refused before the launch. |
| `thinking-argv.test.ts` | A job with a thinking level asks OMP for that level. A job without a level asks for none. A resumed job keeps the level of the source run. |
| `thinking-spawn.test.ts` | A spawn with an unknown thinking level is refused before the launch. The Claude backend refuses every level. A spawn asks OMP for the level. The reply names the requested level. A spawn parameter wins over the config file. A spawn without a parameter takes the level of the config file. A resume keeps the level of the source run. |
| `ledger-sync.test.ts` | A call without a result leaves one outstanding row, and the result settles it. A call at or before the baseline turn opens no row. A call to the report tool opens no row. A background call stays outstanding until the async result names its job. A second sync of the same transcript writes nothing. The close of a run turns an open row into unknown and creates one execution loss event. A sync never reopens a row that is unknown. |
| `native-ledger.test.ts` | An opened native call opens one row. A settled native call settles its row. A failed native call settles its row. A native call without a call id opens no row. A native call to the report tool opens no row. A native settlement without a row creates no row. Another native observation changes no row. Observing a native call updates the state and writes the row. A database error of a native observation does not reach the bridge. |
| `monitor-native.test.ts` | The native monitor keeps a worker that has an open execution row. The native monitor ends a worker when its execution row settles. |
| `startup-block.test.ts` | The three facts of the startup block give the reason of the trust dialog. A session that started gives no reason. A launch of 59 seconds gives no reason and a launch of 61 seconds gives the reason. A pane without the words of the dialog gives no reason. |
| `startup-block-monitor.test.ts` | The native monitor raises one event for a worker that waits at the trust dialog, and a second poll raises no second event. A pane without the dialog raises no event. A session that starts later resolves the event. The status tells the person to accept the trust dialog. |
| `unresolved-launch.test.ts` | An unresolved launch raises one actionable event, and the payload names the attempt and the job. A second recovery raises no second event. The takeover path raises the event for a task that it took. The status lists the event. The resolution `abandoned` and the resolution `incomplete` free the attempt. The resolution `recorded_result` is refused, and the attempt stays unresolved. A session that does not own the task cannot resolve the event. |
| `native-snapshot.test.ts` | A report of the cycle of the snapshot binds after the snapshot. A second snapshot holds the newer state. A snapshot of a closed turn lets the run finish. A snapshot of an open turn blocks the run until the turn ends. A pending instruction of the snapshot blocks the run until it is delivered. The calls and the permission requests of the snapshot become the open ones. An open tool row that the snapshot does not hold becomes settled. A tool row that the snapshot holds stays open. A tool row that the worker created after the snapshot stays open. A background row stays open. A new owner binds the report of a snapshot run and settles the old row. |
| `native-background.test.ts` | A background call opens a row of kind background, and a foreground call opens a row of kind tool. The return of a background call leaves its row open, and the return of a foreground call settles its row. A failed background call settles its row. A started task stores its task id. A notification settles the row of its call for the statuses `completed` and `failed`, and a notification without a call id or without a status leaves the row open. A second notification changes nothing. Two background tasks settle their own rows. A stop settles the row of its task id, and a stop of an unknown task changes nothing. A settled or a stopped task leaves the open calls. A completion report waits for the row of a background task. |
| `claude-mod-background.test.ts` | A background call posts the background flag, and a foreground call posts none. The result of a background call posts the started observation with the call id and the task id. The result of a stop posts the stopped observation with the task id, and it names the call that started the task. A stop of an unknown task posts no call id. A notification posts the settled observation with its ids and its status. A notification without the tags posts null fields. A row of another kind posts none of the background observations. Every handler returns the result of `next` unchanged. |
| `claude-mod-snapshot.test.ts` | The first poll with the launch address sends no snapshot. A change of the token of the owner sends one snapshot. A change of the address of the owner sends one snapshot with the state of the run. A failed snapshot is sent again, and an accepted snapshot is not sent again. The snapshot holds the turn of the run. |
| `wait-result.test.ts` | A wait result with a completed job settles the row of that job, and the completion blocker is null. A wait result with a failed job settles the row. A wait result with a cancelled job settles the row. A wait result with a running job keeps the row open. A wait result and an async result for the same job settle the row once, and the second signal does not overwrite the settlement evidence. A wait result without jobs changes nothing. An interrupted wait result changes nothing. An async result with a running job keeps the row open. A wait result for a job without a row creates no row. |
| `report-poll.test.ts` | The report poll keeps a worker that has an open call. The report poll ends a worker when the result of its call arrives. |
| `background-job-settlement.test.ts` | The result of a read of a background job settles the row of that job. The result of a kill of that job settles the row. The tool result of a background call names its job and its command. A terminal status in that result settles the row. The entries of the measured run settle the row. A background job without a terminal status keeps its row open. The blocker names the job id and the command. |
| `report-reminder.test.ts` | A terminal cycle without a report gives one reminder after the settle time, and none before it. Many ticks give exactly one reminder for the cycle. A report before the end of the grace gives no wake. A report after the wake resolves the event. A thinking cycle and a cycle with an open call give no reminder. The reminder text names `wezterm_worker_report`. A worker with an unknown runtime gets no reminder. A restart sends no second reminder. |
| `status-blocker.test.ts` | The status prints the completion blocker of a worker that cannot end. The status hides the old workers and names the count. The status shows one old worker when the call names it. |
| `status-list.test.ts` | 12 finished workers show 10 and hide 2. An active worker always shows. A finished worker with a pending event always shows. No hidden worker gives hidden 0. The order is newest first inside each group. No worker appears twice. |
| `resume-comms.test.ts` | A resume refuses a message that scores below the minimum. A resume with a clean message goes on. A resume without a message runs no checker command. |
| `takeover.test.ts` | A released task of another session is taken over. A dead owner process gives the task. A live owner process keeps the task. An unreadable process table refuses the takeover. A session that owns an active task refuses the takeover. A session that owns a releasing task refuses the takeover. A session takes back a task that it released. A native worker is taken over and gets a bridge. An ownership that changes during the check refuses the takeover. A takeover of a live worker starts the monitor. A takeover of a worker whose pane is gone ends the worker. A session that takes back a released task of a worker whose pane is gone ends the worker. A takeover of a finished worker keeps its status and starts no monitor. A takeover of a task with an open attempt settles the attempt. |
| `takeover-process.test.ts` | A takeover of a session without a start time stores the start time of its process. A takeover refuses when the session cannot read the start time of its process. A task taken over with a start time is not a lock. |
| `reattach-native.test.ts` | A native worker gets a new bridge and a new handover. The worker follows the new bridge and the old token is refused. The run state keeps the native session id of the worker. Only the open rows of the run become the open calls of the state. The new owner receives the report of the worker and ends the run. An open row blocks the completion until a settlement arrives. attachWorker gives a native worker a bridge and a monitor. attachWorker ends a native worker whose pane is gone. attachWorker keeps the old behaviour for an OMP worker. A handover that cannot be written leaves no bridge and no state. attachWorker fails the worker when the re-attachment fails. |
| `claude-smoke-decisions.test.ts` | The report of a run is read from the lines of its report file. A report binds to the cycle only when the names are equal. A report with no cycle binds to no cycle. The last turn of a bridge log is the cycle that the run delivered last. A command line that names no model passes the check of the default model. The difference of the home folder names a change of the settings. The difference of the home folder names a missing entry. The verdict of the run fails when a step failed. The verdict of the run fails when a step could not run. The verdict of the run gives zero when every step passed. The descendants of a process include every depth below it. The descendants of a process leave the process itself out. |
| `reattach-native-stop.test.ts` | A failed re-attachment closes the pane of the native worker, and the open rows of the run become unknown. A failed re-attachment frees the execution of the group. A stop that the pane list does not confirm leaves the worker running with a pending stop and a monitor, and the next poll ends the worker as failed. |
| `restored-run.test.ts` | The re-attachment marks the usage of the run with the time of the restart. A restored run with a measured turn has a partial usage, and the note says that the counts start at the restart of OMP. A run that never restarted keeps a measured usage. A restored run without a measured turn stays unknown. A restored run with a turn without usage keeps both reasons. |
| `restored-run-text.test.ts` | The turn label says that a restart cut the count. The snapshot notice shows only for a restored run without a snapshot. The delivery of a restored native run says since the restart. The status of a live restored run names the missing snapshot. The status of a run that never restarted shows no restart text. The status of a finished restored run still says since the restart. |
| `recover-task.test.ts` | A finished run without a sent delivery is selected. A cancelled run stays out. A run without a mark is selected. The replay sends only the result that this session owns and never delivered. A delivery that throws does not stop the replay of the next run. The first recovery marks the time and replays no run that ended before it. |
| `restart-delivery.test.ts` | A new main session delivers the result of a worker that lost its pane. A worker that finished before the first recovery is not delivered again. |
| `group-release.test.ts` | A run that ends with its pane closed frees its group, and a new resume takes it. A run that ends with its pane alive keeps its group. A failed launch of a resume frees the group. The recovery frees a group whose holder ended, and it keeps a group whose holder is active, has no job, or still has a live pane. |
| `group-holder.test.ts` | The holder of an ended run frees its group when its pane is gone. The holder of an ended run keeps its group while its pane is open, and the refusal names the pane. The holder of an ended run keeps its group when the pane list cannot be read. An active holder and a holder that this process does not know keep their group. A resume takes the group of a source run whose pane was closed by hand. A resume refuses while the pane of the holder is open. The cleanup of a task whose holder ended with its pane gone goes on. The cleanup refuses and names the pane while the pane of the holder is open. |
| `group-recovery-panes.test.ts` | The startup recovery frees the group of a holder whose pane is gone, and it marks the pane of the run as closed. The recovery keeps the group of a holder whose pane is open, and it keeps the group when the pane list cannot be read. The recovery frees the group of a holder whose pane is closed without a pane list. The recovery reads the pane list one time for two groups. The recovery reads no pane list when no ended holder has an open pane. The recovery keeps the group of an active holder and of a holder that this process does not know. The decision names one result for every state of the pane. |
| `resume-pane.test.ts` | A resume refuses a source run whose pane is still open. A resume refuses a source run when the pane list cannot be read. A resume goes on when the pane of the source run is gone. A resume of a source run without a pane reads no pane list. A resume refuses a completed source run whose pane is still open. A native resume refuses a source run whose pane is still open, and it starts no bridge. |
| `group-lookup.test.ts` | A run finds its group through its session directory. A run without a group has no group. |
| `resume-group.test.ts` | A resume of a resumed run takes the group of the first run. A native resume of a resumed run takes the group of the first run. A resume of a source run without a group refuses, and it changes no group. |
| `cleanup-group.test.ts` | The cleanup of a resumed run refuses while another run holds the group, and the transcript stays. The cleanup of a run without a group deletes the transcript. |
| `cleanup-native.test.ts` | The cleanup of a native run refuses while an event waits for the owner, and the transcript stays. The cleanup deletes the transcript after the owner handled the event. The cleanup of a running native run refuses. The cleanup keeps the worktree while the pane of the native run is open. |
| `authority.test.ts` | A task without an ownership row and a session without an identity pass both rules. The owner of an active task passes both rules. The owner of a releasing task and the owner of a released task fail the control rule. Another session fails both rules while the task is active or releasing. Another session passes the cleanup rule while the task is released. The control rule of a released task names the takeover tool. The details of a refusal name the worker, the owner and the phase. |
| `authority-tools.test.ts` | The cancel of a worker of another session is refused, and the pane stays. The steer of a worker of another session is refused, and the pane receives nothing. The cleanup of a worker of another session is refused, and the transcript stays. The resume of a worker of another session is refused, and the request counts no launch. A session without an identity cancels a worker. A worker without an ownership row is cancelled. A release that starts during a cancel waits for the cancel. The cancel of a task that this session is releasing or released is refused. |
| `authority-record.test.ts` | The ack of a session that does not own the task is refused, and the table of the handling holds no row. The resolve of a session that does not own the task is refused, and the table of the resolutions holds no row. The ack checks the worker of the event, not the worker of the parameter. The owner of a task records an ack and a resolve with the generation. An event without a worker is acknowledged. A session without an identity acknowledges an event. A task without an ownership row acknowledges an event. The delivery of a session that does not own the task sends no message, writes no attempt, and warns once. The delivery of the owner sends the message and writes one sent attempt. |
| `ack-native.test.ts` | The owner acknowledges the event of a native run, and the event leaves the pending events. A second acknowledgement of the same event has no second effect. A different disposition of a handled event is refused. A session that does not own the native task cannot acknowledge its event. An unknown event id is refused. The status tool stops listing the event after the acknowledgement. |

The integration tests run a real `omp` worker in a real Herdr pane. They
take about a minute each.

### The Windows trial

`npm run trial` runs four real tasks with real workers: a survey, a fix that a
test proves, a timeout and a cancel. It writes the report to
`docs/trials/windows-trial.md` and exits with 1 when a check fails.

The trial keeps its state, its fixture and its worktrees under `.trial/` in
the project. The directory is in `.gitignore`, and the trial never deletes it.
The transcripts are the evidence of the run.

The report is a public document, so it holds no path of the machine that ran
the trial. A path under the project becomes a relative path, and every other
path becomes a placeholder such as `<trial state>`. The name of the user
account never appears in the report.

### The writing standard

Every document that an agent reads uses Simplified Technical English.
The `npm run ste100` command scores each one and fails below 80. The command
starts the checker of the ste100 skill, so the standard is a measured result
and not a claim. The skill is the only checker of this repository. See
`docs/adr/0011-the-ste100-skill-is-the-only-checker.md`. The glossary in
`GLOSSARY.md` and the decisions in `docs/adr/` carry the same standard. The
orchestrator and the workers read them both.

### The directories that OMP scans

OMP loads every module of `tools/`, `commands/`, `rules/`, `prompts/`,
`agents/` and `hooks/` inside a plugin package as a custom tool. It imports
the module and runs it when the plugin loads.

The scripts of this repository live in `tooling/` and `scripts/`. The test
`no script sits in a directory that OMP scans as a tool` holds that rule. See
`docs/adr/0008-scripts-live-outside-the-omp-tool-directories.md`.

## License

MIT — see [LICENSE](LICENSE).
