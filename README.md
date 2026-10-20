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

The script links the repo into the OMP plugin registry (`omp plugin link`) and
writes a default config to `~/.omp/agent/wezterm-worker.json`. Start a new OMP
session and the tools are live.

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

Removes the plugin link, the config file and the runtime state directory. No
core OMP file is touched.

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
| `wezterm_worker_status` | List workers, or inspect one by id. Shows `queued`/`running`/`completed`/`failed`/`cancelled`. |
| `wezterm_worker_result` | Read a finished worker's final assistant text. |
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
	"stateDir": "C:/Users/Admin/.omp/agent/wezterm-workers",
	"defaultCwd": "C:/Users/Admin",
	"model": null,
	"tools": null,
	"pollMs": 2000,
	"timeoutMs": 1800000,
	"isolated": false
}
```

Environment overrides: `OMP_WORKER_OMP_BIN`, `OMP_WORKER_WEZTERM_BIN`,
`OMP_WORKER_STATE_DIR`.

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

Every failure is reported back into the main session the same way a success is,
so the main agent never waits on a worker that will not finish.

## Cancellation safety

`wezterm_worker_cancel` closes **only** the pane id recorded for that worker.
It never enumerates or kills unrelated panes, and it never signals processes the
plugin did not create. Panes belonging to the user are never touched.

## Known limitations

- `wezterm cli send-text` sends **text**, not key events, so a running worker's
  TUI cannot be driven from outside. The task is passed as an argv argument
  instead, which means the worker cannot be re-prompted after it finishes
  without opening the pane.
- `omp --cwd` inside the home directory auto-switches to a temp directory, so a
  worker needs a real repository path.
- `isolated: true` needs a git repository. On Windows, `git worktree add` can
  fall back to a plain checkout when block cloning is unavailable.

## Repository layout

```text
omp-wezterm-worker/
├── extensions/
│   └── wezterm-worker.ts        the extension (5 tools)
├── scripts/
│   ├── _paths.sh                shared Windows-path helpers
│   ├── install.sh               link the plugin + write the config
│   ├── uninstall.sh             unlink + remove the config and state
│   ├── move-session.sh          relocate an OMP session into a project
│   └── move-session.ts          the move helper extension it loads
├── config/
│   └── wezterm-worker.example.json
├── package.json                 omp/pi manifest: omp.extensions
└── README.md
```

## License

MIT — see [LICENSE](LICENSE).
