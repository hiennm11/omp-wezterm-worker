---
name: wezterm-omp-pane-ops
description: Use when driving an OMP session from a WezTerm pane on Windows, or when moving an OMP session between projects. Covers spawning a worker into a pane, sending text into a live pane (the Enter-key problem), reading live worker status, the worker lifecycle (result delivery, pane closing, registry across restarts, resuming a finished worker), relocating a session transcript, and the Windows shell traps (WSL on PATH, path forms, plugin linking). Triggers on WezTerm pane, pane worker, send text to a pane, steer a running worker, worker status, resume a finished worker, move an OMP session, resume a session elsewhere, pack a session, omp plugin link, Git Bash vs WSL.
---

# WezTerm + OMP pane operations (Windows)

Operating OMP from WezTerm panes on Windows native. No WSL: WSL holds a
different `omp` build, and every command here would touch the wrong install.

## The Enter-key problem

`wezterm cli send-text` pastes by default. A pasted block never submits in the
OMP TUI: the text lands in the composer, the Enter key never arrives, and the
target sits there waiting forever. Verified side by side:

```bash
# paste mode — text lands, nothing submits
wezterm cli send-text --pane-id 5 "hello"   # composer shows "hello", still running

# key mode — text lands AND submits
wezterm cli send-text --no-paste --pane-id 5 "hello\r"
```

`--no-paste` delivers the bytes as individual key events, so the trailing
`"\r"` arrives as a real Enter. Always use `--no-paste` when the text must be
submitted, and append `"\r"` yourself.

Paste mode additionally concatenates onto the previous line without a
separator. Evidence: sending `"TAB\tHERE"` then, in paste mode, `"PASTED"`
produced `TAB        HEREPASTED` on one line.

### What survives the key path

`--no-paste` types characters; it does not run a shell. Verified:

| Payload | Arrives as |
|---|---|
| `XIN CHÀO 你好` | `XIN CHÀO 你好` — non-ASCII intact |
| `A&B;C\|D>E*F$(G)` | `A&B;C\|D>E*F$(G)` — no shell interpretation |
| `BACK\SLASH` | `BACK\SLASH` — one backslash |
| `TAB\tHERE` | a tab, expanded to spaces by the terminal |
| `LINE1\nLINE2` | `LINE1LINE2` — **the newline is swallowed** |

A payload containing a literal newline arrives as one run-on line. Split it
into separate sends, one per line.

## Spawning into a pane

`split-pane` splits the current pane; `spawn` opens a new tab in the current
window. Both take `--cwd` and both accept an argv array after `--`:

```bash
wezterm cli split-pane --right --cwd "C:/work/repo" -- omp --no-title --cwd "C:/work/repo" "the task"
wezterm cli spawn --cwd "C:/work/repo" -- omp --no-title --cwd "C:/work/repo" "the task"
```

Each pane id prints on stdout. Every value after `--` is its own argv
element, so a task containing spaces, quotes or `$(...)` needs no escaping and
no shell.

`wezterm cli list --format json` reports `pane_id`, `tab_id`, `window_id`,
`title`, `cwd` and `workspace` per pane. Use it to check a pane is still
alive.

A process started this way gets a real TTY, so a full interactive TUI runs in
the pane.

## Reading a pane

`wezterm cli get-text --pane-id N` returns the rendered screen. It is a
**read-only view**: useful for debugging a stuck process, never a source of
truth for a result. A result belongs in the session transcript.

## Session relocation

A live session cannot be relocated from another process. `omp session pack
<session-file> <out.tar>` refuses with:

```
error: Cannot pack <file>: another live omp process writes this session.
Exit it first. Nothing was changed.
```

and produces no archive. The interactive `/move` command needs a confirmation
picker that a script cannot drive.

The scriptable route is to resume the transcript in a short-lived `omp`
process and move it there, using the documented `SessionManager.moveTo(cwd)`:

```bash
OMP_MOVE_TARGET="C:/target/dir" omp --mode rpc --no-ui --no-title \
  --cwd "C:/target/dir" --resume "<session-file>" -e "<helper>.ts"
```

The helper calls `sm.ensureOnDisk()`, waits, `sm.flushSync()`, then
`sm.moveTo(target)`. The transcript, its artifacts and its session id are
preserved; only the owning project changes. The target directory must exist
or be created beforehand.

Resuming a transcript in a second process while the first still holds it
fails. The session must be released first.

### Pack and unpack

`omp session` has three actions: `pack`, `unpack`, `moved`.

```bash
omp session pack <session.jsonl> <out.tar>            # SOURCE + OUTPUT
omp session unpack <out.tar> --cwd <target-dir>        # archive path + target
omp session moved <session.jsonl> --to <machine-name>  # mark the local copy stale
```

`pack` and `moved` take the **session .jsonl path or id**; `unpack` takes the
**archive path**. `unpack` prints the resulting session file path. Omitting
`OUTPUT` reports `error: Missing session. Usage: omp session pack <session>
<out.tar>`.

A **released** session (no process owns it) packs cleanly, with its artifacts
and image blobs. A live one refuses, as shown above.

Session files live under the agent dir in per-project buckets, named by the
slugified absolute cwd. The slug keeps the drive letter, wraps the whole name
in `--`, and turns `:` and every path separator into `-`:

| cwd | bucket under `.omp\agent\sessions\` |
|---|---|
| `D:\repos` | `--D--repos--` |
| `D:\repos\myproject` | `--D--repos-myproject--` |
| `C:\Users\<user>\.omp` | `-.omp` |

`omp session unpack` prints the resulting session file path, which names the
bucket it landed in.

## Windows shell traps

| Fact | Value |
|---|---|
| `bash` on PATH | `C:\Windows\system32\bash.exe` — this is **WSL** |
| Git Bash | `C:\Program Files\Git\bin\bash.exe` |
| `omp` on PATH | `C:\Users\<user>\AppData\Local\omp\omp.exe` |
| Authoritative agent dir | `omp config path` → `C:\Users\<user>\.omp\agent` |

Invoke Git Bash explicitly for any shell script:

```bash
"C:/Program Files/Git/bin/bash.exe" script.sh
```

Under WSL, `omp` resolves to a Linux build, so a script run there edits the
wrong installation. Guard scripts on `OS != Windows_NT` and exit non-zero.

Path forms seen in practice, and how they break:

- `C:\Users\x` — native Windows
- `C:/Users/x` — already converted
- `/d/repos/x` — Git Bash drive-root
- `/mnt/d/repos/x` — MSYS drive mount
- `/home/user` — MSYS home, a **synthetic** path that does not exist on the
  Windows filesystem

`cygpath` is not always on PATH, and `USERPROFILE` is not exported to every
child process. Convert paths yourself, or read the agent dir from
`omp config path` instead of guessing `HOME`.

## Plugin linking

`omp plugin link` resolves the path **against its own cwd**. Passing a
Windows path while the cwd is POSIX produces:

```
Failed to link: package.json not found at /mnt/d/repos/x/D:/repos/x
```

Link with a relative `.` from the package root:

```bash
cd /d/repos/omp-wezterm-worker && omp plugin link .
```

## Extension modules and restarts

A newly added extension module is **not** loaded into a running session by
`/reload-plugins`. A restart is required. Edit-then-reload leaves the agent
running the old code while the file on disk says otherwise.

## The directories that OMP scans in a plugin

OMP loads every module of `tools/`, `commands/`, `rules/`, `prompts/`,
`agents/` and `hooks/` inside a plugin package as a custom tool. It imports
the module and runs it when the plugin loads.

A script in one of these directories runs at every start of OMP. A script that
starts real workers leaves panes behind and makes the startup slow. Put a
script in `tooling/` or `scripts/` instead. The log of OMP shows the failure
as `Custom tool load failed`, and the script runs before the message appears.

## The OMP extension API surface

The runtime API of an omp extension, verified against omp 18.12.3 on Windows:

| Member | Purpose |
|---|---|
| `pi.registerTool({name, label, description, parameters, execute})` | Register a tool. `parameters` is a schema object; `execute(id, params, signal, onUpdate, ctx)` returns `{content, details, isError?}`. |
| `pi.registerCommand(name, {description, handler})` | Register a slash command. |
| `pi.on(event, handler)` | Register an event handler (`session_start`, `session_shutdown`, `tool_call`, …). The handler receives `(event, ctx)`. |
| `pi.sendUserMessage(text, {triggerTurn})` | Inject a user message and start a turn. **This is what wakes the main agent.** |
| `pi.sendMessage(content, {deliverAs, triggerTurn, attribution})` | Inject with an explicit delivery mode. `deliverAs: "steer"` delivers now; `"followUp"` queues behind the current turn. |
| `pi.appendEntry({type:"custom", customType, content})` | Append a custom entry to session state. Does **not** start a turn. |
| `pi.setLabel(label)` | Set the extension's display label. |
| `pi.logger.info/warn/error` | Logging. |
| `pi.zod` | Schema builder: `z.string()`, `z.number()`, `z.boolean()`, `z.array()`, `z.object()`. |
| `pi.ui.notify(message, level?)` | Toast notification. |
| `ctx.setInterval(fn, ms)` / `ctx.clearTimer(handle)` | Managed timers. Isolated like a handler dispatch: a throw is logged, not fatal. |

The authoritative source is `docs/extensions.md` in the upstream repository
(`can1357/oh-my-pi`). Read it before relying on an API detail; the local type
stub is incomplete.

The `pi.sendMessage` options are **not** in the published type stub
(`~/.omp/agent/extensions/.stubs/omp-types.d.ts` lists only `appendEntry` and
`sendUserMessage`), so a delivery that silently does nothing is easy to miss.
Verify a delivery by watching for a new `agent_start` / `turn_start` in the
RPC event stream, not by comparing message timestamps — the timestamps of an
injected message and the reply it triggers can land in the same millisecond.

### Reading the RPC event stream

`omp --mode rpc` emits `agent_start`, `turn_start`, `message_start`,
`message_end`, `message_update`, `tool_execution_start`,
`tool_execution_end`, `turn_end`, `agent_end`, `prompt_result` and
`session_settled`. A tool's real result is on `tool_execution_end` under
`result` — `message_end` carries only the assistant's tool call, not its
output.

## Checking a worker is alive

For a worker running in a pane, the live signals are:

- the pane still listed by `wezterm cli list --format json`
- the session transcript growing
- the transcript's last assistant message: a text-only message ends the turn;
  a message that also carries a tool call is a preamble, not an answer

A preamble such as *"I'll read that file."* precedes a tool call. Treating it
as the result delivers the preamble instead of the answer.

## The omp-wezterm-worker extension

This skill's mechanics are packaged as an OMP extension at
`D:\repos\omp-wezterm-worker` (public: `github.com/hiennm11/omp-wezterm-worker`).
It registers `wezterm_spawn_worker`, `wezterm_worker_status`,
`wezterm_worker_steer`, `wezterm_worker_peek`, `wezterm_worker_result`,
`wezterm_worker_resume`, `wezterm_worker_cancel` and `wezterm_worker_cleanup`.

**The extension's README is the source of truth for its tools and parameters.**
Read it rather than recalling them. What belongs here is only the operating
knowledge the README cannot state:

- The extension starts a real interactive CLI in a pane. The default backend
  is OMP. Set `backend: "claude"` for Claude Code. Codex is not implemented.
- OMP activity comes from its session JSONL. Claude activity comes from the
  native observations. Pane text is a debug view, not completion evidence.
- A worker gets the **exact task and cwd**, and does not inherit the main
  conversation.
- Editing the extension source needs an **OMP restart**; `/reload-plugins`
  does not pick up a newly added module.
- Installing means `omp plugin link .` from the package root plus a config
  file at `~/.omp/agent/wezterm-worker.json`. Keep one copy: a second copy in
  `~/.omp/agent/extensions/` loads the extension twice.
- The scripts need Git Bash, not WSL.

### Claude workers and project skills

Before a Claude launch, check that the mounted spawn schema exposes `backend`.
If it does not, restart OMP with the updated plugin. Do not claim a Claude launch through an OMP-only schema.

Set `cwd` to the target project. Claude discovers the project's `.claude/skills/`
and the user's `~/.claude/skills/` through its own configuration.
The extension does not copy OMP skills into Claude.
For the discovery rules, see [Claude skills](https://code.claude.com/docs/en/skills).

Put the required skill names, commands, constraints, and acceptance criteria in `task`.
Tell the worker to load each required skill before work.
Task text instructs the worker. It does not add CLI flags or execute a shell command at launch.

The spawn tool has no arbitrary command, custom settings, or extra plugin option.
For the supported parameters, read the README.
Omit `tools` for a Claude worker. The tool refuses an OMP tool list for a native backend.
The worker keeps the user's permission rules. A person answers a permission request in the pane.
An isolated worker uses a separate checkout. Do not assume that untracked project skills exist there.

## Worker lifecycle

```text
spawn ──> running ──> completed ──> (pane closed) ──> resume ──> running
             │                                            ▲
             ├──> failed / cancelled ────────────────────┘
             │
             └──> OMP restarts ──> re-attached from registry.json
                             └──> launch attempt unresolved ──> owner resolves
```

Four behaviours that are easy to get wrong:

**Delivery must wake the agent.** The result arrives through
`pi.sendUserMessage(text, { triggerTurn: true })`. That lands the text in the
session as a user message and starts a new turn, so the agent acts on a
finished worker immediately. `pi.sendMessage(..., { deliverAs: "steer" })` is
the fallback for a host without `sendUserMessage`; a `followUp` queues behind
whatever the agent is doing, so it must not be used for a result.

**The pane is closed when the worker finishes.** Reading the result must come
first: the transcript is the result source and the worker stops writing once
its pane is gone. `closePaneOnFinish: false` keeps the pane for inspection,
but finished panes accumulate. A deadline (`timeoutMs`, `idleTimeoutMs`) still
closes the pane, because the worker is still running. The job ends as `failed`
only after the pane list shows the pane gone. Until then the job stays
`running` with a `stop` reason, and `wezterm_worker_cancel` accepts it again.

**The lifecycle database holds the worker records.** `stateDir/lifecycle.db` is
a SQLite database through `node:sqlite`. It holds every worker, the ownership,
the launch attempts, the shared resources, the execution ledger, and the
events. A new OMP process reads it at startup, so `wezterm_worker_status` still
lists workers that survived the previous process, and the extension re-monitors
any whose pane is still alive. A worker whose pane was closed while OMP was
down is marked `failed`.

The old `stateDir/registry.json` is migrated once. The file stays on disk as
evidence. The extension never writes it again, because two processes that
wrote the same file lost one another's records.

**The worker reports its own task state.** The worker gets the tool
`wezterm_worker_report`. That tool is worker-only. The main session never
gets it, and a worker never gets the tools of the main session.

A report is the only evidence that the supervisor accepts. Answer text, pane
text, and transcript growth prove nothing. The launch appends a system
prompt that states the reporting contract, and the launch sets
`OMP_WORKER_SESSION_DIR` so the worker process knows that it is a worker.
A WezTerm pane inherits the environment of the process that started it.

**A launch that lost its receipt does not start a second worker.** A crash
between the pane creation and the receipt leaves a launch attempt without a
receipt. The recovery finds the live worker by its command line, which
carries the `--session-dir` of the worker. A worker that is not found leaves
the attempt unresolved. The attempt keeps its capacity, and the owner settles
it with `wezterm_worker_resolve`. The extension never sends the launch
command again.

**A finished worker is continued with `--resume`, not with steering.**
Steering needs a live pane, and a completed worker has none.
`wezterm_worker_resume` starts `omp --resume <transcript>` in a fresh pane,
so the worker returns with its whole history and accepts a follow-up
instruction. The resumed run shares the transcript and the worktree of its
source run, so a resource group keeps a second writer out.

**Completion is counted from the newest user message.** A resumed transcript
already holds a finished turn, so a completion check over the absolute counts
reports the *previous* answer as the new result before the worker did any
work. Count assistant turns and tool calls only since the last user message,
and require at least one assistant turn in that window.

**A worker's worktree outlives the worker.** An isolated worker owns a `git
worktree` on branch `omp/worker/<jobId>`. The extension never removes it —
not on completion, not on cancel, not on timeout. `wezterm_worker_cleanup` is
the only thing that removes one, and it checks `git status --porcelain`
first: a checkout with uncommitted changes or untracked files is **kept** and
the changed paths are listed, because those changes are the worker's output.
`force: true` discards them. The branch is never deleted by the extension, so
commits survive the worktree.

**A steering message is confirmed, not assumed.** `wezterm cli send-text`
returns success as soon as the keystrokes reach the pane. A worker needs a
few seconds to start its interface, and keystrokes that arrive before that
go nowhere. The extension therefore sends the instruction once and reads the
worker's transcript after the send. The transcript confirms the delivery only
when it records the requested text. Any other growth of the transcript is not
a confirmation. A delivery that the transcript does not confirm stays
unconfirmed, and the extension never sends the instruction again. A second
copy of the same instruction reaches the worker as a second instruction.

**A cancel and a deadline stop are confirmed.** `kill-pane` returns success
when WezTerm accepts the request, not when the pane is gone. The extension
polls the pane list and ends the job only when the pane is missing. An
unreadable list means unknown, never gone. An unconfirmed stop leaves the job
`running`. Call `wezterm_worker_cancel` again to retry.

**Limits are enforced in code.** Three workers are active at most by default
(`maxActiveWorkers`). The main session is not counted. One request launches at
most three workers (`maxLaunchesPerRequest`). A worker cannot launch a worker.
A refused launch returns an error that names the rule. Raise the limits in the
config file when you need more. A user prompt starts a new request.

**Tokens are measured, not estimated.** `wezterm_worker_status` shows the
tokens of each worker and of the request, read from the transcripts. The value
`unknown` means that the transcript holds no usage data. Report it as unknown.
The main session is not counted.

## Extension runtime rules (OMP)

From the official extension docs (`can1357/oh-my-pi` → `docs/extensions.md`):

- **The extension factory parameter is named `pi` and its type is
  `ExtensionAPI`.** That is the host's own convention, not a legacy name.
- **Do not call action methods during extension load.** `pi.sendMessage()` and
  friends throw `ExtensionRuntimeNotInitializedError` while the factory runs.
  Register first; do runtime work from `pi.on("session_start", ...)`, a
  command, or a tool.
- **Background work must use `ctx.setInterval`, not a raw `setInterval`.**
  Extensions run in-process with no isolation: a throw in a raw timer callback
  becomes a process-level `uncaughtException` and tears the **whole session**
  down. `ctx.setInterval` contains the failure, is `unref`'d, and is cleared
  automatically on `session_shutdown`.
- **`pi.setLabel(label)`** sets the extension's display label. It is not a
  session-entry labelling action.
- `pi.zod` is the schema builder; `pi.registerTool`, `pi.registerCommand` and
  `pi.on` are the registration methods.

## The domain vocabulary

The repository holds a glossary at `GLOSSARY.md`. It defines the terms of
this domain: **worker**, **result**, **preamble**, **turn**, **steering
message**, **resume**, **transcript**, **delivery**, **registry**,
**worktree**. It also defines the supervision terms: **report**, **task
state**, **execution condition**, **instruction cycle**, **execution
record**, **resource group**, **launch attempt**, **unresolved launch**,
**owner resolution**, **release**, **drain**. Use these words. A term with a
second name makes the next reader guess.

Two terms cause the most confusion:

- A **preamble** is the text of an assistant message that also carries a tool
  call. A preamble is not the result.
- A **turn** is one assistant message. A turn that calls a tool is not the end
  of the work. Only a text-only turn ends it.

The decisions and their reasons live in `docs/adr/`. Read an ADR before you
change the behaviour it describes.

## Writing for the other agents

The orchestrator and the workers read these documents. Write them in Simplified
Technical English, and check the result.

Apply these rules:

- Use one word for one concept.
- Use one instruction per sentence.
- Use the active voice and name the actor.
- Use simple tenses. Write "the worker reads the file", not "the worker is
  reading the file".
- Keep the articles. Write "the file", not "file".
- Use "must" and "can". Write "must" where a rule applies.
- Limit a sentence to 20 words for a procedure. Limit a sentence to 25 words
  for a description.
- Delete filler words such as "simply" and "just".

Run `npm run ste100` in the repository. The command scores every document
that an agent reads. It fails below 80.
