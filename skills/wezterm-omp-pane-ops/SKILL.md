---
name: wezterm-omp-pane-ops
description: Use when driving an OMP session from a WezTerm pane on Windows, or when moving an OMP session between projects. Covers spawning a worker into a pane, sending text into a live pane (the Enter-key problem), reading live worker status, relocating a session transcript, and the Windows shell traps (WSL on PATH, path forms, plugin linking). Triggers on WezTerm pane, pane worker, send text to a pane, steer a running worker, worker status, move an OMP session, resume a session elsewhere, pack a session, omp plugin link, Git Bash vs WSL.
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
`wezterm_worker_cancel` and `wezterm_worker_cleanup`.

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
