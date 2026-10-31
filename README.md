# omp-wezterm-worker

Spawn an **OMP worker session inside a WezTerm pane or tab** that runs on its
own. The user sees it live while the main agent keeps working. The main session
receives the final result of the worker automatically.

Verified against **omp 18.12.3** on **Windows native** (no WSL), WezTerm
**20240203-110809-5046fc22**.

## What this is (and what it is not)

Three distinct mechanisms. They are not interchangeable:

| Mechanism | What it is | Pane? | Result delivery | Where to see it |
|---|---|---|---|---|
| Native subagent (`task` tool) | In-process child OMP session | No | OMP-managed async job injection | Agent Hub (`Alt+A`), pinned Subagents block |
| **WezTerm worker (this plugin)** | A **separate `omp` process** in a WezTerm pane, own model/tools/session file | **Yes** | `pi.sendUserMessage` back into the main session | The pane itself, live |
| Pane transcript view | `wezterm cli get-text` — rendered screen text only | — | Not a result source | Read-only text dump |

This plugin creates a **real, interactive OMP TUI** in the pane. It is not a
transcript replay and not a fake TUI. The user can click into the pane and speak
to the worker directly.

## Install

You need: omp, WezTerm (`wezterm` on PATH), Git Bash (or any Windows bash).

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

`/wezterm-workers` prints the roster in the TUI.

The tools `wezterm_worker_steer`, `wezterm_worker_cancel`,
`wezterm_worker_cleanup`, `wezterm_worker_resume`, `wezterm_worker_ack` and
`wezterm_worker_resolve` check the authority of the task before they act. The
delivery of a result checks it too. A session that does not hold the authority
gets one refusal that names the session that holds it. The refusal says
`Worker <id> belongs to session <S> (phase <P>). This session only reads it.`
A session without an identity and a task without an ownership row keep the old
behaviour. The automatic path of a monitor checks the authority too.

The worker reports its own task state through `wezterm_worker_report`. That
tool is worker-only. The main session never gets it.

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
| `backend` | `"omp"` \| `"claude"` \| `"codex"` | The CLI that runs the worker. Defaults to `omp`. The extension never falls back to another backend. |
| `model` | string | Optional model selector, e.g. `omniroute/minimax/MiniMax-M3.1-Flash`. Omit for omp's default. The role aliases `smol`, `task` and `slow` select a model. These aliases apply to an OMP worker only. A Claude Code worker receives the value unchanged. |
| `tools` | string[] | Optional tool list, e.g. `["read","grep","glob"]`. Omit for the default set. An OMP worker only. |
| `placement` | `"split"` \| `"tab"` | `split` splits the current pane; `tab` opens a new tab. |
| `isolated` | boolean | Run in a dedicated `git worktree` so parallel workers never edit the same checkout. |
| `timeoutMs` | number | Deadline for this worker. `0` means **no deadline**. Defaults to the configured `timeoutMs` (30 min). |
| `closePaneOnFinish` | boolean | Close the worker's pane when it finishes. Defaults to the config value (`true`). Set `false` to leave the pane open for inspection. |

### The Claude Code backend

A spawn that names `backend: "claude"` runs a real interactive Claude Code
session in the pane. The session loads a session-scoped mod that carries the
report tool and the command bridge.

| Rule | Behavior |
|---|---|
| The configuration of the user | The session keeps the settings, the credentials, the MCP servers and the permission rules of the user. The extension never changes a global setting. |
| The model | An omitted model uses the default of Claude Code. A named model is passed through unchanged. |
| The tool list | A spawn with `tools` and a native backend is refused before the launch. |
| The deadline | A native worker takes the `timeoutMs` and the `closePaneOnFinish` of its spawn, the same way an OMP worker does. |
| The report | The mod binds the report to the run id and to the native turn id. A report of an earlier turn cannot finish newer work. |
| The steering | A steering instruction goes through the bridge. The native session queues it, and a running tool is not interrupted. |
| The permission | A permission request raises an event for the owner. The person answers it in the pane. A steering instruction is refused while the request is open. |
| The events | The status tool lists the events that wait for the owner. The owner acknowledges each one with its event id. The conditions are `result`, `needs_input`, `missing_report`, `idle_after_working`, `execution_loss`, `unresolved_launch`, `unknown_outcome`, `permission_request` and `startup_blocked`. |
| The startup | A Claude worker in a new repository raises `startup_blocked`, because the session waits at the trust dialog of Claude Code. The person accepts the dialog in the pane. |
| The usage | The native CLI reports the usage of a turn when the turn ends. A run waits for the end of its turn, so the measured counts survive the end of the run. The usage of a request adds the native workers to the OMP ones. |
| The activity | A native worker writes no OMP transcript. Its activity comes from the native observations, so the idle deadline never stops a worker that is still working. |
| The resume | A resume reuses the native session id. The worker comes back with its history and a new run id. |
| The stop | The stop closes the pane of the worker only, and it confirms that the pane is gone. |

The Codex backend has no implementation yet. The extension refuses a spawn that
names it. The first slice adds the spawn function of a Codex worker. It
starts the app server of Codex in one pane, the TUI of Codex in a second pane
and the task as the first turn. The refusal stays until the last slice,
because a Codex worker has no report tool and no stop path yet.

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

Implementation note: `wezterm cli send-text` pastes by default. A pasted block
never submits in the OMP TUI. The text lands in the composer but the Enter
key never arrives. So steering uses `--no-paste`, which delivers the bytes
as individual key events. Steering also adds a trailing `"\r"` that the worker
receives as a real Enter.

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

## How it works

1. `wezterm cli split-pane` (or `wezterm cli spawn`) creates the pane and runs
   `omp --no-title --cwd <cwd> --session-dir <job dir> [--model M] [--tools T] "<task>"`.
   Every value is a **separate argv element**. The extension never mixes the
   task into a shell command. So a quote cannot break the command, and nobody
   can put extra text into it.
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
	"codexBin": "codex",
	"weztermBin": "wezterm",
	"placement": "split",
	"stateDir": "C:/Users/<you>/.omp/agent/wezterm-workers",
	"defaultCwd": "C:/Users/<you>",
	"model": null,
	"tools": null,
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

Environment overrides: `OMP_WORKER_OMP_BIN`, `OMP_WORKER_WEZTERM_BIN`,
`OMP_WORKER_STATE_DIR`.

- `timeoutMs` — total deadline for a worker, in ms. `0` disables it.
- `codexBin` — the Codex program that a Codex worker runs. The default is
  `codex`. An absolute path to a file names the program directly. Any other
  name is looked up with the command `where`. The extension never runs a
  shell, because the arguments of the app server would reach the shell first.
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
input. It ends at a terminal assistant boundary with no open tool call. A
report inside the cycle satisfies the rule. A working report followed by a
verified idle worker is a separate condition.

The supervisor refuses a completion report while a tool call or a background
execution has no evidence of a settlement. The supervisor cannot see every
detached process, so it does not claim that it can.

**The result wakes the main agent.** The extension sends the finished result
with `pi.sendUserMessage(text, { triggerTurn: true })`. The text lands in the
session as a user message and starts a new turn. The agent works on a finished
worker right away. `pi.sendMessage` with `deliverAs: "steer"` is the fallback
for a host that does not expose `sendUserMessage`.

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
| OMP restarts after the user closed the pane | The worker is marked `failed` with "Worker pane was closed before this session re-attached". A worker with a pending stop gets the status of that stop. |
| The pane list cannot be read | The pane state is unknown. It is never treated as gone. A stop stays unconfirmed, and the startup check does not fail the worker. |
| A launch breaks a limit | The spawn or the resume is refused with an error that names the rule. No worker and no pane are created. |

The extension reports every failure back into the main session. It reports a
success in the same way. So the main agent never waits on a worker that will
not finish.

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
deliver an Enter key to a WezTerm pane (`send-text` pastes by default, and a
paste never submits). It explains how to relocate a session transcript.

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
│   │   ├── job.ts               the worker record and its run state
│   │   ├── runs.ts              the worker runs in the database
│   │   ├── transcript.ts        reading a worker's transcript
│   │   ├── calls.ts             the tool calls of a transcript, paired by id
│   │   ├── cycle.ts             the instruction cycle of a worker
│   │   ├── report-model.ts      the report that a worker sends
│   │   ├── report-store.ts      the reports of a session directory
│   │   ├── report-binding.ts    the binding of a report to a run and a cycle
│   │   ├── report-decision.ts   the decision that the reports produce
│   │   ├── usage.ts             the measured token usage of a worker
│   │   ├── runtime.ts           the shared state and the services (the test seam)
│   │   ├── process.ts           running a child process
│   │   ├── host.ts              the shape of the OMP extension API
│   │   ├── pane.ts              the WezTerm panes
│   │   ├── worktree.ts          the isolated git worktree
│   │   ├── spawn.ts             starting and resuming a worker
│   │   ├── spawn-claude.ts      starting a Claude Code worker
│   │   ├── spawn-codex.ts       starting a Codex worker
│   │   ├── resume-claude.ts     resuming a Claude Code worker
│   │   ├── resume-guard.ts      the pane check of the source run of a resume
│   │   ├── claude-session.ts    the Claude Code session of a worker
│   │   ├── codex-binary.ts      the Codex program of the machine and its version
│   │   ├── codex-client.ts      the client of one Codex app server
│   │   ├── codex-launch.ts      the app server, the TUI and the first turn of a Codex worker
│   │   ├── codex-process.ts     the processes and the panes of a Codex worker
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
│   │   ├── steer-native.ts      steering a worker that runs a native backend
│   │   ├── limits.ts            the launch limits and the nested-worker rule
│   │   ├── monitor.ts           watching a worker and the deadline rules
│   │   ├── monitor-authority.ts the authority of a monitor to end a worker
│   │   ├── monitor-actions.ts   the counted actions of a monitor
│   │   ├── startup-block.ts     the startup block of a native run
│   │   ├── lifecycle.ts         finishing and cancelling a worker
│   │   ├── steer.ts             steering a running worker
│   │   ├── deliver.ts           delivering a result to the main session
│   │   ├── db.ts                the lifecycle database
│   │   ├── migrate.ts           the one-time migration of the old registry
│   │   ├── ownership.ts         the ownership of a task, its release and its takeover
│   │   ├── owner.ts             the acquisition of a task by this session
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
│       └── roster.ts            the /wezterm-workers command
├── scripts/
│   ├── _paths.sh                shared Windows-path helpers
│   ├── install.sh               link the plugin + write the config + install the skill
│   ├── uninstall.sh             unlink + remove the config, state and skill
│   ├── move-session.sh          relocate an OMP session into a project
│   └── move-session.ts          the move helper extension it loads
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
│   └── backend-proof/           the modules of the probe
│       ├── codex-background.ts  the background scenario of the Codex proof
│       ├── codex-binary.ts      the search of the Codex program of the machine
│       ├── codex-handle.ts      the handle of a Codex scenario and the rules of its evidence
│       ├── codex-dialog.ts      the TUI of a Codex scenario that answers the approval dialogs
│       ├── codex-queue.ts       the queue scenario of the Codex proof
│       ├── codex-resume.ts      the resume scenario of the Codex proof
│       └── codex-tui.ts         the pane evidence and the approval of the Codex TUI
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
│   ├── architecture.test.ts     the size, import and runtime rules
│   ├── ste100-docs.test.ts      the document check of the skill
│   ├── comms-check.test.ts      the communication check of the skill
│   ├── trial-report.test.ts     the text of the Windows trial report
│   ├── trial-paths.test.ts      the paths that the report hides
│   ├── registration.test.ts     the tools that the extension registers
│   ├── backend.test.ts          the backend of a run and the report binding
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
│   ├── report-poll.test.ts      the report poll and the outstanding executions
│   ├── status-blocker.test.ts   the completion blocker in the status tool
│   ├── status-list.test.ts      the list of workers that the status tool shows
│   ├── resume-comms.test.ts     the communication check of the resume tool
│   ├── proof-codex.test.ts      the source of each Codex protocol message and the rules of the evidence
│   ├── proof-codex-background.test.ts  the background file of the Codex proof and the verdict of it
│   ├── proof-codex-binary.test.ts the search of the Codex program of the machine
│   ├── proof-codex-scenarios.test.ts the queue, no-report and approval scenarios of the Codex proof
│   ├── codex-binary.test.ts     the Codex program, its version and its refusal
│   ├── codex-spawn.test.ts      the spawn of a Codex worker and its cleanup
│   ├── codex-spawn-helpers.ts   the fakes of the tests of a Codex spawn
│   ├── takeover.test.ts         the takeover of a task of another session
│   ├── takeover-process.test.ts the process record of the new owner of a task
│   ├── takeover-helpers.ts      the helpers of the takeover tests
│   ├── reattach-native.test.ts  the re-attachment of a native worker after a restart
│   ├── reattach-native-stop.test.ts the stop of a native worker whose re-attachment fails
│   ├── reattach-native-helpers.ts the helpers of the re-attachment tests
│   ├── restored-run.test.ts    the usage of a native run that a restart restored
│   ├── restored-run-text.test.ts the texts of a restored native run
│   ├── recover-task.test.ts    the replay of a result that a restart lost
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
│   ├── worker.integration.test.ts    a real worker in a real pane
│   ├── nested.integration.test.ts    the launch limits with a real worker
│   ├── worktree.integration.test.ts  the worktree of a real worker
│   └── native-worktree.integration.test.ts  the worktree of a real native worker
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
| `npm run proof:codex` | Run the compatibility probe against a real Codex session. It starts an app server and a TUI. It needs an evidence directory. |
| `npm run smoke:claude` | Run the smoke test of the Claude Code backend. It starts a real session, reports, resumes and steers. |
| `npm run typecheck` | Type check the extension, the tools and the tests. |
| `npm run check` | Run the lint, the type check, the scores and the tests. |

The integration tests need `omp` and `wezterm` on PATH. Without them the tests
report that they cannot run. They never report a pass they did not observe.

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
| `architecture.test.ts` | No source file exceeds 350 lines. The `lib/` folder never imports the entry or `worker-tools/`. Only `lib/process.ts` starts a child process. Only the entry creates the runtime. |
| `limits.test.ts` | One active worker blocks a launch at the default limit. A worker with an unconfirmed stop still counts. A launch that failed before its pane existed does not count. A worker session cannot launch a worker. A user prompt resets the request count. |
| `usage.test.ts` | A number comes only from a transcript. A model call without usage makes the count partial. A transcript without usage shows unknown. A resumed worker counts only what came after the resume. The request total adds the workers of the request. |
| `nested.integration.test.ts` | A real worker cannot launch a worker and opens no pane. A second spawn is refused while one worker is active. |
| `ste100-docs.test.ts` | The document check gives every document and the reporting contract to the checker of the skill. The check fails with the code 2 when the skill is not built. |
| `comms-check.test.ts` | A text that scores 80 or more passes. A low score warns in the warn mode and fails in the enforce mode. The checker runs with node on a file that holds the text. A missing skill gives the verdict skipped with a note. A Vietnamese text, a short text and the off mode never start the checker. |
| `claude-argv.test.ts` | A new Claude Code worker and a resumed one both get the reporting contract as one argv element. The task stays the last argument. |
| `worker.integration.test.ts` | A real worker completes. The result is delivered. The pane closes. The registry survives a new process. A resumed worker answers the new message. |
| `worktree.integration.test.ts` | The worktree survives the worker. Cleanup keeps a worktree with changes. Cleanup with force removes it, and the branch survives. |
| `result.integration.test.ts` | The result tool returns the answer of a finished worker. |
| `live-worker.integration.test.ts` | A running worker can be steered, peeked at and cancelled. A steering message reaches the worker. A cancel closes only the pane that the extension created. A worker past its deadline is stopped and its pane is confirmed closed. A session releases the worker that it started, and the worker keeps running. |
| `owner.test.ts` | A session that starts a worker owns it. A session without an identity acquires nothing. The same session acquires its task again after a restart only when the old process is gone. A second live process of the same session does not take the task. A reused process id does not count as the old owner. An unreadable process table refuses the acquisition. Another session never takes a task. |
| `process-probe.test.ts` | The probe reads the start time of a live process. Two reads of one process give the same start time. The probe reports a gone process as gone. |
| `trial-report.test.ts` | The report names a failing check. A check detail stays on one line. The report holds no path of the machine. |
| `trial-paths.test.ts` | A path under the project becomes a relative path. A path outside it becomes a placeholder. The name of the user never appears. |
| `registration.test.ts` | The extension registers the eight tools that the agent needs. It registers the roster command. |
| `backend.test.ts` | A run without a backend field is an OMP run. A backend that is not implemented is refused, and the extension never falls back. A report of an earlier cycle cannot finish newer work. |
| `claude-run-state.test.ts` | A native turn starts the cycle. A call settles only when the same call settles. A failed call leaves the open calls and the completion blocker. A failed call closes its permission request. A permission request holds the completion. An accepted instruction blocks the completion until its cycle carries it. |
| `spawn-backend.test.ts` | A spawn with an unknown backend is refused. A spawn with a backend that is not implemented is refused, and the extension never falls back. A spawn with a tool list and a native backend is refused before the launch. |
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
| `status-blocker.test.ts` | The status prints the completion blocker of a worker that cannot end. The status hides the old workers and names the count. The status shows one old worker when the call names it. |
| `status-list.test.ts` | 12 finished workers show 10 and hide 2. An active worker always shows. A finished worker with a pending event always shows. No hidden worker gives hidden 0. The order is newest first inside each group. No worker appears twice. |
| `resume-comms.test.ts` | A resume refuses a message that scores below the minimum. A resume with a clean message goes on. A resume without a message runs no checker command. |
| `proof-codex.test.ts` | A notification gives the source of its method. A request gives the source of its method. A response gives the source of a response and keeps its id. A message without a method and without an id gives the unknown source. The real pane text of the approval dialog shows the dialog. A pane text without a dialog does not show the dialog. An empty pane text does not show the dialog. The real pane text of the command dialog shows the command dialog. The pane text of the MCP dialog does not show the command dialog. An empty pane text does not show the command dialog. The pane text of the command dialog shows the command kind. The pane text of the MCP dialog shows the MCP kind. A pane text without a dialog shows no kind. An empty pane text shows no kind. The newest dialog wins when the command dialog is the last one. The newest dialog wins when the MCP dialog is the last one. The report server options name the proof variables. The report server options hold no token value and no url value. The report server options keep the command and the path. The options of one scenario hold a list of their own. The options of one scenario keep the evidence store of the run. An observation of one scenario stays out of the list of another scenario. A scenario that wrote no evidence does not pass. A scenario that wrote evidence keeps its verdict. A scenario without evidence does not pass even when it failed. A process of a name that is not codex must not end. A process of the name codex may end. A process of a name that holds codex but is not codex must not end. A process without a name must not end. | |
| `proof-codex-background.test.ts` | The background task names the absolute path of the file. A background file that appears after the report passes. A background file that appears before the report fails. A background file that never appears fails. A background turn without a report fails. A background file with a wrong content fails. A background turn without a command fails. A file that was written before the report keeps the time of its write. A file that never existed has no time. The time of a file is the time of its last write. The background task asks the model not to wait for the process. The evidence of the background scenario holds the end of the turn. |
| `proof-codex-scenarios.test.ts` | The task of the queue scenario keeps the turn busy. The queue scenario sends its instruction with a client id. The queue scenario counts a delivered instruction by its client id. The queue scenario passes when an accepted entry became a delivered input. The queue scenario fails when the native program refused the instruction. The queue scenario fails when the accepted entry never reached the model. The task of the no-report scenario forbids a tool. The no-report scenario fails when a report arrived. The no-report scenario passes when a turn ended and no report arrived. The no-report scenario stays unavailable when the turn never ended. The approval scenario pins a policy that asks the person. |
| `takeover.test.ts` | A released task of another session is taken over. A dead owner process gives the task. A live owner process keeps the task. An unreadable process table refuses the takeover. A session that owns an active task refuses the takeover. A session that owns a releasing task refuses the takeover. A session takes back a task that it released. A native worker is taken over and gets a bridge. An ownership that changes during the check refuses the takeover. A takeover of a live worker starts the monitor. A takeover of a worker whose pane is gone ends the worker. A session that takes back a released task of a worker whose pane is gone ends the worker. A takeover of a finished worker keeps its status and starts no monitor. A takeover of a task with an open attempt settles the attempt. |
| `takeover-process.test.ts` | A takeover of a session without a start time stores the start time of its process. A takeover refuses when the session cannot read the start time of its process. A task taken over with a start time is not a lock. |
| `reattach-native.test.ts` | A native worker gets a new bridge and a new handover. The worker follows the new bridge and the old token is refused. The run state keeps the native session id of the worker. Only the open rows of the run become the open calls of the state. The new owner receives the report of the worker and ends the run. An open row blocks the completion until a settlement arrives. attachWorker gives a native worker a bridge and a monitor. attachWorker ends a native worker whose pane is gone. attachWorker keeps the old behaviour for an OMP worker. A handover that cannot be written leaves no bridge and no state. attachWorker fails the worker when the re-attachment fails. |
| `reattach-native-stop.test.ts` | A failed re-attachment closes the pane of the native worker, and the open rows of the run become unknown. A failed re-attachment frees the execution of the group. A stop that the pane list does not confirm leaves the worker running with a pending stop and a monitor, and the next poll ends the worker as failed. |
| `restored-run.test.ts` | The re-attachment marks the usage of the run with the time of the restart. A restored run with a measured turn has a partial usage, and the note says that the counts start at the restart of OMP. A run that never restarted keeps a measured usage. A restored run without a measured turn stays unknown. A restored run with a turn without usage keeps both reasons. |
| `restored-run-text.test.ts` | The turn label says that a restart cut the count. The snapshot notice shows only for a restored run without a snapshot. The delivery of a restored native run says since the restart. The status of a live restored run names the missing snapshot. The status of a run that never restarted shows no restart text. The status of a finished restored run still says since the restart. |
| `recover-task.test.ts` | A finished run without a sent delivery is selected. A cancelled run stays out. A run without a mark is selected. The replay sends only the result that this session owns and never delivered. A delivery that throws does not stop the replay of the next run. The first recovery marks the time and replays no run that ended before it. |
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

The integration tests run a real `omp` worker in a real WezTerm pane. They
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
