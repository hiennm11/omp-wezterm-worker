# omp-wezterm-worker

Spawn an independent **OMP worker session inside a WezTerm pane or tab**. The
user watches it live while the main agent keeps working; the worker's final
result is delivered back into the main session automatically.

Verified against **omp 18.12.3** on **Windows native** (no WSL), WezTerm
**20240203-110809-5046fc22**.

## What this is (and what it is not)

Three distinct mechanisms. They are not interchangeable:

| Mechanism | What it is | Pane? | Result delivery | Where to see it |
|---|---|---|---|---|
| Native subagent (`task` tool) | In-process child OMP session | No | OMP-managed async job injection | Agent Hub (`Alt+A`), pinned Subagents block |
| **WezTerm worker (this plugin)** | A **separate `omp` process** in a WezTerm pane, own model/tools/session file | **Yes** | `pi.sendMessage` back into the main session | The pane itself, live |
| Pane transcript view | `wezterm cli get-text` — rendered screen text only | — | Not a result source | Read-only text dump |

This plugin creates a **real, interactive OMP TUI** in the pane. It is not a
transcript replay and not a fake TUI. The user can click into the pane and talk
to the worker directly.

## Install

Requires: omp, WezTerm (`wezterm` on PATH), Git Bash (or any Windows bash).

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

Removes the plugin link, the config file, the runtime state directory and the
installed skill. No core OMP file is touched.

## Moving an OMP session into a project

`scripts/move-session.sh` relocates an existing OMP transcript so it belongs to
a different project directory:

```bash
"C:/Program Files/Git/bin/bash.exe" scripts/move-session.sh <session-file-or-id> <target-dir>
```

The session must not be owned by a running omp process — a live session cannot
be relocated from outside, and the interactive `/move` command needs a
confirmation picker that a script cannot drive. The script therefore resumes
the transcript in a short-lived omp process and moves it there with the
documented `SessionManager.moveTo(cwd)` path. The transcript, its artifacts and
its session id are preserved; only the owning project changes.

The interactive alternative, if you are in the TUI: type `/move <dir>` and
confirm the picker.

## Tools

| Tool | Purpose |
|---|---|
| `wezterm_spawn_worker` | Start a worker. Returns worker id, pane id, tab id, cwd, transcript path. Does not wait. |
| `wezterm_worker_status` | List workers, or inspect one by id. Shows lifecycle state, elapsed time, idle time, the tool running right now, turn count and steering count. |
| `wezterm_worker_steer` | Send a new instruction into a **running** worker. It arrives as a follow-up user message and the worker keeps going. |
| `wezterm_worker_peek` | Show the last visible lines of a worker's pane. A debug aid for a worker that looks stuck. |
| `wezterm_worker_result` | Read a finished worker's final assistant text. |
| `wezterm_worker_resume` | Reopen a **finished** worker in a new pane, continuing its transcript, optionally with a follow-up instruction. |
| `wezterm_worker_cancel` | Cancel a worker and close **only** the pane that worker created. |
| `wezterm_worker_cleanup` | Release a finished worker's isolated worktree and transcript directory. |

`/wezterm-workers` prints the roster in the TUI.

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
| `model` | string | Optional model selector, e.g. `omniroute/minimax/MiniMax-M3.1-Flash`. Omit for omp's default. |
| `tools` | string[] | Optional tool list, e.g. `["read","grep","glob"]`. Omit for the default set. |
| `placement` | `"split"` \| `"tab"` | `split` splits the current pane; `tab` opens a new tab. |
| `isolated` | boolean | Run in a dedicated `git worktree` so parallel workers never edit the same checkout. |
| `timeoutMs` | number | Deadline for this worker. `0` means **no deadline**. Defaults to the configured `timeoutMs` (30 min). |
| `closePaneOnFinish` | boolean | Close the worker's pane when it finishes. Defaults to the config value (`true`). Set `false` to leave the pane open for inspection. |

### Long tasks

A worker runs for as long as it needs, up to its deadline. The deadline is a
**total** limit, not a per-poll limit — a worker that keeps making progress is
never interrupted mid-task.

- `timeoutMs: 0` on the spawn call removes the deadline entirely.
- The configured default is 30 minutes (`timeoutMs` in the config file).
- `idleTimeoutMs` (config file, default `0` = disabled) is a separate safety
  net: it fails a worker that produced no transcript activity for that long.
  A worker that is thinking or waiting on a slow tool still writes to its
  transcript, so this only fires on a genuinely stuck worker.

The main agent never blocks on a worker. It can keep working for hours while
the worker runs, and the result is delivered back when the worker finishes.

### Steering a running worker

`wezterm_worker_steer` sends text into a running worker's composer and
submits it, exactly as if the user had typed it:

```
wezterm_worker_steer(workerId: "wz-...", message: "Stop surveying and focus on the parser only")
```

The worker receives it as a follow-up user message and continues from its
current state. Steering does not cancel the worker and does not lose the
result: the final answer is still delivered back automatically.

Steering a worker that has already finished reports that fact instead of
sending text into a dead pane.

Implementation note: `wezterm cli send-text` pastes by default, and a pasted
block never submits in the OMP TUI — the text lands in the composer but the
Enter key never arrives. Steering therefore uses `--no-paste`, which delivers
the bytes as individual key events, plus a trailing `"\r"` that the worker
receives as a real Enter.

### Watching a worker

`wezterm_worker_status` reports, for each worker:

| Field | Meaning |
|---|---|
| `elapsed` | Wall-clock time since the worker started, plus the deadline it will hit. |
| `idle` | Time since the worker last wrote to its transcript. A worker that is thinking or waiting on a slow tool still writes, so a growing `idle` means it is stuck. |
| `running` | The tool the worker is inside right now, when there is one. |
| `turns` | How many assistant turns the worker has taken. |
| `steers` | How many steering messages were sent into this worker. |

`wezterm_worker_peek` shows the last lines rendered in the worker's pane. It
is a debug aid for a worker that looks stuck. The transcript remains the only
source of truth for the result.

## How it works

1. `wezterm cli split-pane` (or `wezterm cli spawn`) creates the pane and runs
   `omp --no-title --cwd <cwd> --session-dir <job dir> [--model M] [--tools T] "<task>"`.
   Every value is a **separate argv element** — the task is never concatenated
   into a shell command, so quoting and injection are impossible.
2. The worker runs the real OMP TUI. It gets its own model, tools and session
   file. It does **not** inherit the main conversation (OMP child sessions never
   inherit history).
3. The extension polls the worker's session JSONL for a final assistant text
   block with no outstanding tool call.
4. On completion the result is pushed back with `pi.sendMessage`
   (`deliverAs: "followUp"`, `triggerTurn: true`, `attribution: "agent"`), so
   the main agent receives it without the user reading a file.

The worker's **session file is the source of truth** for the result — pane
screen text is never scraped for results.

## Configuration

`~/.omp/agent/wezterm-worker.json`:

```json
{
	"ompBin": "omp",
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
	"closePaneOnFinish": true
}
```

Environment overrides: `OMP_WORKER_OMP_BIN`, `OMP_WORKER_WEZTERM_BIN`,
`OMP_WORKER_STATE_DIR`.

- `timeoutMs` — total deadline for a worker, in ms. `0` disables it.
- `idleTimeoutMs` — fail a worker that produced no transcript activity for
  this long, in ms. `0` disables it (the default).
- `pollMs` — how often the extension checks the worker transcript.
- `closePaneOnFinish` — close the worker's pane when it finishes. `true` by
  default, so a finished worker does not leave a pane behind. Set `false` to
  keep the pane open so the user can read the worker's screen.

## Worker lifecycle

```text
spawn ──> running ──> completed ──> (pane closed) ──> resume ──> running
             │                                            ▲
             ├──> failed / cancelled ────────────────────┘
             │
             └──> OMP restarts ──> re-attached from registry.json
```

**The result wakes the main agent.** The finished result is delivered with
`pi.sendUserMessage(text, { triggerTurn: true })`, which lands the text in the
session as a user message and starts a new turn. The agent acts on a finished
worker right away. `pi.sendMessage` with `deliverAs: "steer"` is the fallback
for a host that does not expose `sendUserMessage`.

**The pane is closed when the worker finishes.** A finished worker leaves its
pane open by default, and those panes accumulate. `closePaneOnFinish` closes
the pane after the result is read — the transcript is the result source, and
the worker stops writing once its pane is gone. Set `closePaneOnFinish: false`
per spawn or in the config to keep the pane for inspection.

**The registry survives a restart.** Every worker is written to
`stateDir/registry.json` (atomic write: temp file plus rename). A new OMP
process reads that file on startup, so `wezterm_worker_status` still lists
workers that were running when the previous process ended, and the extension
re-attaches a monitor to any whose pane is still alive. A worker whose pane
was closed while OMP was down is marked `failed`.

**A finished worker can be resumed.** `wezterm_worker_resume` starts a new
`omp --resume <transcript>` in a fresh pane, so the worker comes back with its
whole history and can be given a follow-up instruction. This is the only way
to continue a worker that already completed — steering needs a live pane.

A resumed transcript already holds a finished turn, so the extension records
how many assistant turns the transcript had when the worker started. Only a
turn **beyond** that baseline counts as the new result — otherwise the
previous answer is delivered as the new one before the worker has done any
work.

## Concurrency safety

Two workers editing the same checkout is a real hazard. Two options:

- **`isolated: true`** — the worker gets its own `git worktree`
  (`omp/worker/<jobId>` branch) under `stateDir/worktrees/`. Requires a git repo.
  The worktree is released automatically once the worker pane is closed
  (the worker's own process holds the directory open until then).
- **Restrict worker tools** — pass `tools: ["read","grep","glob"]` so the worker
  cannot write at all. Use this for survey/analysis work.

`task.isolation.enabled` in OMP's own config governs the **native** `task`
subagents only; it does not affect these workers.

## Failure handling

| Situation | Behaviour |
|---|---|
| `cwd` does not exist | Spawn fails immediately with `cwd does not exist: <path>`. No pane is created. |
| `omp` binary missing or not runnable | Spawn fails immediately with the underlying spawn error. No empty pane is left behind. |
| Worker dies during startup (bad model, crash) | The pane disappears with no transcript; the monitor marks the worker `failed` after a 45 s grace period and delivers the failure. |
| Worker exceeds `timeoutMs` | The worker is marked `failed` with a timeout message. |
| User closes the worker pane | The worker stays in the registry; the isolated worktree (if any) is released. |
| OMP restarts while a worker runs | The worker is re-read from `registry.json` and re-monitored if its pane is still alive. |
| OMP restarts after the user closed the pane | The worker is marked `failed` with "Worker pane was closed before this session re-attached". |

Every failure is reported back into the main session the same way a success is,
so the main agent never waits on a worker that will not finish.

## Cancellation safety

`wezterm_worker_cancel` closes **only** the pane id recorded for that worker.
It never enumerates or kills unrelated panes, and it never signals processes the
plugin did not create. Panes belonging to the user are never touched.

## Known limitations

- A worker can be steered **while it runs** (`wezterm_worker_steer`). A worker
  that already finished is continued with `wezterm_worker_resume`, which
  reopens it in a new pane from its transcript.
- The registry is per-process in memory and mirrored to `registry.json`. A
  worker spawned in one OMP process is visible in another through the file, but
  a **result** is only delivered to the process that spawned it.
- `omp --cwd` inside the home directory auto-switches to a temp directory, so a
  worker needs a real repository path.
- `isolated: true` needs a git repository. On Windows, `git worktree add` can
  fall back to a plain checkout when block cloning is unavailable.
- The extension module loads at OMP startup. A newly added module is not
  picked up by `/reload-plugins`; restart OMP.

## The companion skill

`skills/wezterm-omp-pane-ops/SKILL.md` is installed to
`~/.omp/agent/skills/wezterm-omp-pane-ops/SKILL.md` by `scripts/install.sh`.

It carries the operating knowledge this README cannot state: how to deliver an
Enter key to a WezTerm pane (`send-text` pastes by default, and a paste never
submits), how to relocate a session transcript, and the Windows shell traps
(`bash` on PATH is WSL, path forms, relative plugin linking). The skill is
model-invoked, so an agent reaches for it on its own when a task involves a
pane or a session move.

## Repository layout

```text
omp-wezterm-worker/
├── extensions/
│   └── wezterm-worker.ts        the extension (8 tools)
├── scripts/
│   ├── _paths.sh                shared Windows-path helpers
│   ├── install.sh               link the plugin + write the config + install the skill
│   ├── uninstall.sh             unlink + remove the config, state and skill
│   ├── move-session.sh          relocate an OMP session into a project
│   └── move-session.ts          the move helper extension it loads
├── skills/
│   └── wezterm-omp-pane-ops/
│       └── SKILL.md             operating knowledge for the model
├── config/
│   └── wezterm-worker.example.json
├── package.json                 omp/pi manifest: omp.extensions
└── README.md
```

## License

MIT — see [LICENSE](LICENSE).
