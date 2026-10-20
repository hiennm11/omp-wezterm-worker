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
| **WezTerm worker (this plugin)** | A **separate `omp` process** in a WezTerm pane, own model/tools/session file | **Yes** | `pi.sendUserMessage` back into the main session | The pane itself, live |
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
| `wezterm_worker_cleanup` | Release a finished worker's transcript directory and its isolated worktree. A worktree with uncommitted changes is kept unless `force` is set. |

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
4. On completion the result is delivered with `pi.sendUserMessage`
   (`triggerTurn: true`), so the main agent starts a turn and acts on it
   without the user reading a file. See `docs/adr/0004-deliver-with-send-user-message.md`.

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
	"closePaneOnFinish": true,
	"maxActiveWorkers": 1,
	"maxLaunchesPerRequest": 3
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
- `maxActiveWorkers` — refuse a spawn or a resume while this many workers are
  active. The default is `1`. `0` disables the limit. A worker whose stop is
  not confirmed counts as active.
- `maxLaunchesPerRequest` — refuse a launch after this many launches since the
  last user prompt. The default is `3`. `0` disables the limit.
- A worker cannot launch a worker. The code refuses the call and the error
  names the rule. See `docs/adr/0007-limits-and-usage-enforced-in-code.md`.

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
per spawn or in the config to keep the pane for inspection. That flag keeps the
pane of a worker that is done. A worker that passes its `timeoutMs` or
`idleTimeoutMs` deadline is still running, so its pane is closed anyway.
Closing the pane is the only way to stop it. If the close fails, the `error` of
the job says that the worker may still run.

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
  The worktree **survives the worker**: it is not removed when the worker
  finishes, is cancelled, or times out. See "Isolated worktrees" below.
- **Restrict worker tools** — pass `tools: ["read","grep","glob"]` so the worker
  cannot write at all. Use this for survey/analysis work.

`task.isolation.enabled` in OMP's own config governs the **native** `task`
subagents only; it does not affect these workers.

### Isolated worktrees

A worker that commits, edits or creates files has produced work. That work is
kept: the extension never removes a worktree on its own.

| Moment | What happens to the worktree |
|---|---|
| Worker finishes, is cancelled, or times out | Kept. The branch `omp/worker/<jobId>` and the checkout both survive. |
| `wezterm_worker_cleanup` without `force` | Kept when the checkout has uncommitted changes or untracked files. The changed paths are listed. |
| `wezterm_worker_cleanup` with `force: true` | Removed. The branch is **kept**, so commits the worker made survive. |

Cleanup checks the checkout with `git status --porcelain` before removing
anything. A worktree with changes is reported, not deleted — the changes are
the worker's output. Pass `force: true` only when discarding them is intended.

The branch is never deleted by the extension. Remove it yourself with
`git branch -d omp/worker/<jobId>` once its content is merged or no longer
needed.

## Failure handling

| Situation | Behaviour |
|---|---|
| `cwd` does not exist | Spawn fails immediately with `cwd does not exist: <path>`. No pane is created. |
| `omp` binary missing or not runnable | Spawn fails immediately with the underlying spawn error. No empty pane is left behind. |
| Worker dies during startup (bad model, crash) | The pane disappears with no transcript; the monitor marks the worker `failed` after a 45 s grace period and delivers the failure. |
| Worker exceeds `timeoutMs` | The worker is marked `failed` with a timeout message. |
| User closes the worker pane | The worker stays in the registry; the isolated worktree (if any) is kept. |
| OMP restarts while a worker runs | The worker is re-read from `registry.json` and re-monitored if its pane is still alive. |
| OMP restarts after the user closed the pane | The worker is marked `failed` with "Worker pane was closed before this session re-attached". |

Every failure is reported back into the main session the same way a success is,
so the main agent never waits on a worker that will not finish.

## Cancellation safety

`wezterm_worker_cancel` closes **only** the pane id recorded for that worker.
It never enumerates or kills unrelated panes, and it never signals processes the
plugin did not create. Panes belonging to the user are never touched.

A worker ends only after the pane list shows its pane is gone. If the list
still shows the pane, or cannot be read, the worker stays `running` with a
visible `stop` reason. Call `wezterm_worker_cancel` again to retry. The monitor
also retries on every poll. See `docs/adr/0006-stopped-means-confirmed.md`.

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
- The extension never deletes a worktree or its branch. Worktrees accumulate
  under `stateDir/worktrees/` until `wezterm_worker_cleanup` is called on them,
  and their branches accumulate in the repository until they are deleted by
  hand.
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
│   ├── wezterm-worker.ts        the entry: wires the runtime, the events and the tools
│   ├── lib/                     the worker lifecycle, with no tool schema
│   │   ├── config.ts            the config file and the defaults
│   │   ├── job.ts               the worker record and its run state
│   │   ├── registry.ts          the registry file
│   │   ├── transcript.ts        reading a worker's transcript
│   │   ├── runtime.ts           the shared state and the services (the test seam)
│   │   ├── process.ts           running a child process
│   │   ├── host.ts              the shape of the OMP extension API
│   │   ├── pane.ts              the WezTerm panes
│   │   ├── worktree.ts          the isolated git worktree
│   │   ├── spawn.ts             starting and resuming a worker
│   │   ├── limits.ts            the launch limits and the nested-worker rule
│   │   ├── monitor.ts           watching a worker and the deadline rules
│   │   ├── lifecycle.ts         finishing and cancelling a worker
│   │   ├── steer.ts             steering a running worker
│   │   └── deliver.ts           delivering a result to the main session
│   └── worker-tools/            one module for each tool
│       ├── kit.ts               the shared reply and the worker lookup
│       ├── spawn.ts, status.ts, steer.ts, peek.ts
│       ├── result.ts, resume.ts, cancel.ts, cleanup.ts
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
├── tools/
│   ├── ste100.ts                the Simplified Technical English checker
│   └── ste100-cli.ts            the checker command line
├── tests/
│   ├── harness.ts               a test host for the extension
│   ├── transcript.test.ts       reading a transcript
│   ├── config.test.ts           the config file
│   ├── registry.test.ts         the registry file
│   ├── stop.test.ts             a stop that waits for the pane to close
│   ├── limits.test.ts           the launch limits
│   ├── monitor.test.ts          the timeout, the idle limit and the result rule
│   ├── architecture.test.ts     the size, import and runtime rules
│   ├── ste100.test.ts           the checker and the document scores
│   ├── worker.integration.test.ts    a real worker in a real pane
│   ├── nested.integration.test.ts    the launch limits with a real worker
│   └── worktree.integration.test.ts  the worktree of a real worker
├── docs/
│   └── adr/                     the decisions and their reasons
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
| `npm test` | Run every test, one file at a time. The integration tests spawn a real worker in a real pane. |
| `npm run test:unit` | Run only the tests that need no worker. |
| `npm run test:integration` | Run only the tests that spawn a real worker. |
| `npm run lint` | Check the format and the lint rules. |
| `npm run lint:fix` | Apply the fixes that Biome can apply. |
| `npm run ste100` | Score every agent-facing document. The score must reach 80. |
| `npm run typecheck` | Type check the extension, the tools and the tests. |
| `npm run check` | Run the lint, the type check, the scores and the tests. |

The integration tests need `omp` and `wezterm` on PATH. Without them the tests
report that they cannot run. They never report a pass they did not observe.

The tests run one file at a time. Two workers that run at the same time share
one WezTerm window, so a test that counts the panes would see the panes of
the other test.

### The essential tests

Each test protects one behaviour. A change that breaks a behaviour breaks a
test.

| Test | The behaviour it protects |
|---|---|
| `transcript.test.ts` | A preamble is not the result. A new user message resets the counts. A resumed worker reports only a turn beyond its baseline. |
| `config.test.ts` | The environment wins over the file. A value of the wrong type leaves the default. A malformed file leaves the defaults. |
| `registry.test.ts` | A running worker with a pane comes back as alive. A job of the wrong shape does not break the load. The write is atomic. |
| `stop.test.ts` | A cancel ends a worker only when the pane list shows the pane gone. An unreadable pane list does not count as a closed pane. An unconfirmed stop leaves the worker running, and a retry ends it. |
| `monitor.test.ts` | A worker with no deadline never times out. An active worker still times out at the total deadline. A worker that keeps writing is not stopped as idle. A resumed worker does not report its old answer. |
| `architecture.test.ts` | No source file exceeds 350 lines. The `lib/` folder never imports the entry or `worker-tools/`. Only `lib/process.ts` starts a child process. Only the entry creates the runtime. |
| `limits.test.ts` | One active worker blocks a launch at the default limit. A worker with an unconfirmed stop still counts. A launch that failed before its pane existed does not count. A worker session cannot launch a worker. A user prompt resets the request count. |
| `nested.integration.test.ts` | A real worker cannot launch a worker and opens no pane. A second spawn is refused while one worker is active. |
| `ste100.test.ts` | Each agent-facing document reaches the required score. |
| `worker.integration.test.ts` | A real worker completes. The result is delivered. The pane closes. The registry survives a new process. A resumed worker answers the new message. |
| `worktree.integration.test.ts` | The worktree survives the worker. Cleanup keeps a worktree with changes. Cleanup with force removes it, and the branch survives. |
| `result.integration.test.ts` | The result tool returns the answer of a finished worker. |
| `live-worker.integration.test.ts` | A running worker can be steered, peeked at and cancelled. A steering message reaches the worker. A cancel closes only the pane that the extension created. A worker past its deadline is stopped and its pane is confirmed closed. |

The last three run a real `omp` worker in a real WezTerm pane. They take about
a minute each.

### The writing standard

Every document that an agent reads is written in Simplified Technical English.
The `npm run ste100` command scores each one and fails below 80. The checker
lives in `tools/ste100.ts`, so the standard is a measured result and not a
claim. The glossary in `GLOSSARY.md` and the decisions in `docs/adr/` carry the
same standard, because the orchestrator and the workers read them both.

## License

MIT — see [LICENSE](LICENSE).
