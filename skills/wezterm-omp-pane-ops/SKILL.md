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

- The extension **spawns a real `omp` TUI process** in a pane. It is not a
  native subagent, and not a transcript view. A native subagent has no pane;
  a pane transcript view has no separate process.
- Its result source is the worker's **session JSONL**, never scraped pane
  text. Pane text is a debug view.
- A worker gets the **exact task and cwd**, and does not inherit the main
  conversation.
- Editing the extension source needs an **OMP restart**; `/reload-plugins`
  does not pick up a newly added module.
- Installing means `omp plugin link .` from the package root plus a config
  file at `~/.omp/agent/wezterm-worker.json`. Keep one copy: a second copy in
  `~/.omp/agent/extensions/` loads the extension twice.
- The scripts need Git Bash, not WSL.

## Worker lifecycle

```text
spawn ──> running ──> completed ──> (pane closed) ──> resume ──> running
             │                                            ▲
             ├──> failed / cancelled ────────────────────┘
             │
             └──> OMP restarts ──> re-attached from registry.json
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
but finished panes accumulate.

**The registry is a file, not just a map.** `stateDir/registry.json` holds
every worker, written atomically (temp file plus rename). A new OMP process
reads it at startup, so `wezterm_worker_status` still lists workers that
survived the previous process, and the extension re-monitors any whose pane is
still alive. A worker whose pane was closed while OMP was down is marked
`failed`.

**A finished worker is continued with `--resume`, not with steering.**
Steering needs a live pane, and a completed worker has none.
`wezterm_worker_resume` starts `omp --resume <transcript>` in a fresh pane,
so the worker returns with its whole history and accepts a follow-up
instruction.

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
