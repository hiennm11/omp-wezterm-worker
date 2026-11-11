---
name: wezterm-omp-pane-ops
description: Use when driving an OMP session from a Herdr pane on Windows, or when moving an OMP session between projects. Covers spawning a worker into a pane, sending text into a live pane (agent prompt and the line-break rule), reading live worker status, the worker lifecycle (result delivery, pane closing, registry across restarts, resuming a finished worker), relocating a session transcript, and the Windows shell traps (WSL on PATH, path forms, plugin linking). Triggers on Herdr pane, pane worker, send text to a pane, steer a running worker, worker status, resume a finished worker, move an OMP session, resume a session elsewhere, pack a session, omp plugin link, Git Bash vs WSL.
---

# Herdr + OMP pane operations (Windows)

## Acknowledging a worker result

A result needs acknowledgement after it is read. A stale no-action event expires after 24 hours by default. Set `eventExpiryMs` in the config file to change the limit, or set `0` to disable expiry. The current task owner closes the event when it loads the task. Results and events that need a decision stay pending. The system records `expired` and keeps the event row.

Operating OMP from Herdr panes on Windows native. The extension runs only
inside a Herdr session (`HERDR_ENV=1`). It never starts a Herdr server. No
WSL: WSL holds a different `omp` build, and every command here would touch the
wrong install.

The OMP backend and the Claude Code backend run on Herdr and on WezTerm. Every
pane call of a worker goes through the runtime that started it, so neither
backend refuses the other runtime (ADR 0027).

## Sending text to a pane

`herdr agent prompt <target> <text>` sends the text and the Enter key in one
call. A pasted block does not submit in the OMP TUI, and `agent prompt` does
not paste, so the Enter-key problem of `wezterm cli send-text` is gone.

```bash
herdr agent prompt wz-1 "Reply with exactly: HELLO"
```

Measured on Herdr 0.9.5:

| Case | Result |
|---|---|
| `agent prompt` while OMP runs a turn | Returns at once. The agent stays `working`. OMP queues the text. The text does not interrupt the turn. |
| A text with line breaks, quotes and `$(...)` | Arrives as one user message. The line breaks stay. |
| `pane send-keys <pane> /restart` | Refused: `send-keys` takes key names, not text. Use `pane send-text` for text, then `pane send-keys <pane> enter`. |

## The line-break rule

`herdr agent start` refuses an argument with a line break, a carriage return
or a tab: `agent arguments cannot be encoded safely for the target shell`. A
real task has line breaks. So the extension starts OMP with no task in the
argv, waits until the agent is ready, and sends the task with `agent prompt`.
A launch that fails after the pane opened closes that pane.

The Claude Code backend gives a contract of many lines. The launch writes the
contract into the session directory and passes the path with
`--append-system-prompt-file`. The path has no line break, so it reaches
Herdr. The contract text itself never goes into the argv.

## Spawning into a pane

`herdr pane split` divides a pane. `herdr tab create` opens a new tab. Both
take `--cwd` and `--env`. `herdr agent start` then runs the program in that
pane. Every value after `--` is its own argv element:

```bash
herdr pane split --current --direction right --cwd "C:/work/repo" --no-focus
herdr agent start wz-1 --kind omp --pane w1:p2 -- --no-title --cwd "C:/work/repo"
```

The reply of a pane holds the pane id, such as `w1:p2`. Herdr names the pane,
and the extension never builds an id. Never use `herdr pane run`: it joins its
words into one shell string and loses the argv. Never give `tab_id` to the
socket method `layout.apply`: it replaces the panes of that tab.

`herdr agent start` picks the program by `--kind` from the PATH. The keys
`ompBin` and `claudeBin` of the config file do not change the program that
Herdr starts. Put the program that you want first on the PATH.

The flag `--thinking <level>` sets the thinking level of an OMP worker. The
values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` and
`auto`. The spawn tool takes it as the optional parameter `thinking` (ADR 0015).
A native backend refuses it. OMP can lower a level that the model lacks, and the
transcript does not record the level that ran. The spawn reply names the level
that the plugin asked for.

The spawn tool also accepts the optional parameter `preset`. Presets come from the `presets` key in the configuration file. A call parameter wins over its preset. The preset wins over the global configuration, which wins over the default. The OMP worker always receives `wezterm_worker_report`, `wezterm_worker_note_to_main` and `wezterm_worker_notes_from_main` when a non-empty restricted tool list omits them.

`herdr pane list` reports `pane_id`, `tab_id`, `workspace_id` and `agent_status`
per pane. Use it to check a pane is still alive. Herdr has no window id, so the
field `windowId` of a job holds null.

A process started this way gets a real TTY, so a full interactive TUI runs in
the pane.

## Reading a pane

`herdr pane read <pane> --source recent-unwrapped --lines N` returns the
rendered screen. It is a **read-only view**: useful for debugging a stuck
process, never a source of truth for a result. A result belongs in the session
transcript.

## Session relocation

Another process cannot move a live session. `omp session pack
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
`sm.moveTo(target)`. The move keeps the transcript, its artifacts and its
session id. Only the owning project changes. The target directory must exist
before the move. Create it beforehand if it does not exist.

Resuming a transcript in a second process while the first still holds it
fails. The first process must release the session first.

### Pack and unpack

`omp session` has three actions: `pack`, `unpack`, `moved`.

```bash
omp session pack <session.jsonl> <out.tar>            # SOURCE + OUTPUT
omp session unpack <out.tar> --cwd <target-dir>        # archive path + target
omp session moved <session.jsonl> --to <machine-name>  # mark the local copy stale
```

`pack` and `moved` take the **session .jsonl path or id**. `unpack` takes the
**archive path**. `unpack` prints the resulting session file path. Omitting
`OUTPUT` reports `error: Missing session. Usage: omp session pack <session>
<out.tar>`.

A **released** session (no process owns it) makes a clean archive with its
artifacts and image blobs. A live one refuses, as shown above.

Session files live under the agent dir in per-project buckets, named by the
slugified absolute cwd. The slug keeps the drive letter and puts the whole
name in `--`. It turns `:` and every path separator into `-`:

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

Path kinds seen in practice, and how they break:

- `C:\Users\x` — native Windows
- `C:/Users/x` — already uses forward slashes
- `/d/repos/x` — Git Bash drive-root
- `/mnt/d/repos/x` — MSYS drive folder
- `/home/user` — MSYS home, a **synthetic** path that does not exist on the
  Windows filesystem

`cygpath` is not always on PATH. The shell does not export `USERPROFILE` to
every child process. Convert paths yourself, or read the agent dir from
`omp config path` instead of guessing `HOME`.

## Plugin linking

`omp plugin link` resolves the path **against its own cwd**. The plugin link
gives this result when the cwd is POSIX and the path is a Windows path:

```
Failed to link: package.json not found at /mnt/d/repos/x/D:/repos/x
```

Link with a relative `.` from the package root:

```bash
cd /d/repos/omp-wezterm-worker && omp plugin link .
```

## Extension modules and restarts

A newly added extension module does **not** load into a running session when
you call `/reload-plugins`. You need a restart. Edit-then-reload leaves the
agent running the old code while the file on disk says otherwise.

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
(`can1357/oh-my-pi`). Read it before you rely on an API detail. The local type
stub is incomplete.

The `pi.sendMessage` options are **not** in the published type stub
(`~/.omp/agent/extensions/.stubs/omp-types.d.ts` lists only `appendEntry` and
`sendUserMessage`), so a delivery that silently does nothing is easy to miss.
Verify a delivery by monitoring a new `agent_start` / `turn_start` in the
RPC event stream. Do not compare message timestamps. The timestamps of an
added message and the reply it causes can land in the same millisecond.

### Reading the RPC event stream

`omp --mode rpc` sends `agent_start`, `turn_start`, `message_start`,
`message_end`, `message_update`, `tool_execution_start`,
`tool_execution_end`, `turn_end`, `agent_end`, `prompt_result` and
`session_settled`. A tool's real result is on `tool_execution_end` under
`result`. `message_end` carries only the assistant's tool call, not its
output.

## Checking a worker is alive

**An isolated worktree starts without `node_modules`.** Run `npm ci` there before a check. Without that step `npx biome` downloads biome 0.3.3, which is not the pinned `@biomejs/biome`, so its report means nothing. Check with `./node_modules/.bin/biome --version`.

For a worker running in a pane, the live signals are:

- the pane still listed by `herdr pane list`
- the session transcript becomes longer
- the transcript's last assistant message: a text-only message ends the turn.
  a message that also carries a tool call is a preamble, not an answer

A preamble such as *"I'll read that file."* comes before a tool call. Apply
it as the result and you deliver the preamble instead of the answer.

## The omp-wezterm-worker extension

The mechanics of this skill run as an OMP extension at
`D:\repos\omp-wezterm-worker` (public: `github.com/hiennm11/omp-wezterm-worker`).
It registers fourteen tools for the main session: `wezterm_spawn_worker`,
`wezterm_worker_status`, `wezterm_worker_ack`, `wezterm_worker_steer`,
`wezterm_worker_peek`, `wezterm_worker_result`, `wezterm_worker_resume`,
`wezterm_worker_cancel`, `wezterm_worker_cleanup`, `wezterm_worker_release`,
`wezterm_worker_takeover`, `wezterm_worker_resolve`,
`wezterm_worker_note_to_worker` and `wezterm_worker_notes_from_worker`.

**The extension's README is the source of truth for its tools and parameters.**
Read it. Do not recall them. What belongs here is only the operating
knowledge the README cannot state:

- The extension starts a real interactive CLI in a pane. The default backend
  is OMP. Set `backend: "claude"` for Claude Code. See ADR 0010.
- OMP activity comes from its session JSONL. Claude activity comes from the
  native observations. Pane text is a debug view. It does not prove completion.
- A worker gets the **exact task and cwd**, and does not inherit the main
  conversation.
- Editing the extension source needs an **OMP restart**. `/reload-plugins`
  does not pick up a newly added module.
- Installing means `omp plugin link .` from the package root plus a config
  file at `~/.omp/agent/wezterm-worker.json`. Keep one copy: a second copy in
  `~/.omp/agent/extensions/` loads the extension twice.
- The scripts need Git Bash, not WSL.

### Claude workers and project skills

Before a Claude launch, check that the spawn schema of OMP exposes `backend`.
If it does not, restart OMP with the updated plugin. Do not claim a Claude launch through an OMP-only schema.
Before a Claude spawn, the extension validates the session mod. A rejected mod or a failed check refuses the spawn and adds about 1.5 seconds.

Set `cwd` to the target project. Claude finds the project's `.claude/skills/`
and the user's `~/.claude/skills/` through its own configuration.
The extension does not copy OMP skills into Claude.
For the discovery rules, see [Claude skills](https://code.claude.com/docs/en/skills).

Put the skill names, commands, constraints and acceptance criteria that the
worker needs in `task`.
Tell the worker to load each of these skills before work.
Task text instructs the worker. It does not add CLI flags and it does not run
a shell command at launch.

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
session as a user message and starts a new turn. The agent works on a finished
worker immediately. `pi.sendMessage(..., { deliverAs: "steer" })` is
the fallback for a host without `sendUserMessage`. A `followUp` queues behind
whatever the agent does, so you must not use it for a result.

An actionable event wakes the agent the same way, once for each event
(ADR 0016). A message that arrives while the agent is in a turn goes on the
steering queue. The host delivers it at the turn boundary and does not abort the
running tool. The events `result` and `execution_loss` do not wake the agent
this way. The condition `missing_report` means that a cycle ended without a
report. It does not mean that the worker is dead. Read the transcript before you
steer.

The extension reminds the worker before it wakes the agent (ADR 0028). A cycle
that ends without a report gets one reminder in the pane of that worker. The
reminder names the tool `wezterm_worker_report`. The worker then has 120
seconds to report. The event `missing_report` comes only when that time
passes without a report. One cycle gets one reminder, and a restart sends
nothing. A report inside the cycle resolves the event.

The cycle kind `thinking` means that the last entry is a tool result, or that
the last assistant message did not end its turn with text. A thinking model can
take longer than 30 seconds between two tool calls. The kind raises no
`missing_report`. After 600 seconds without a new transcript entry, the monitor
raises the event `thinking_stall` once for each last entry. The event wakes the
main session and never stops the worker. An open tool call, for example a long
build, is not a stall. The limit is a constant, not a config key. In the
measured data, no gap between a tool result and the next answer was above 600
seconds. No run has shown the event in a real pane yet.

**The extension closes the pane when the worker finishes.** Reading the
result must come first. The transcript is the result source. The worker stops
writing once its pane is gone. `closePaneOnFinish: false` keeps the pane for
inspection, but finished panes collect over time.

A deadline (`timeoutMs`,
`idleTimeoutMs`) still closes the pane, because the worker still runs. The job
ends as `failed` only after the pane list shows the pane gone. Until then the
job stays `running` with a `stop` reason. `wezterm_worker_cancel` accepts it
again.

**The lifecycle database holds the worker records.** `stateDir/lifecycle.db` is
a SQLite database through `node:sqlite`. It holds every worker, the ownership,
the launch attempts, the shared resources, the execution ledger, and the
events. A new OMP process reads it at startup. Thus `wezterm_worker_status`
still lists workers that survived the previous process. The extension
re-monitors each worker whose pane is still alive. The extension marks as
`failed` a worker whose pane closed while OMP was down.

The extension migrates the old `stateDir/registry.json` once. The file stays
on disk as evidence. The extension never writes it again, because two
processes that wrote the same file lost one another's records.

**The worker reports its own task state.** The worker gets the tool
`wezterm_worker_report`. That tool is worker-only. The main session never
gets it, and a worker never gets the tools of the main session.

A report is the only evidence that the supervisor accepts. Answer text, pane
text, and transcript growth prove nothing. The launch appends a system
prompt that states the reporting contract, and the launch sets
`OMP_WORKER_SESSION_DIR` so the worker process knows that it is a worker.
A Herdr pane inherits the environment of the process that started it.

**A launch that lost its receipt does not start a second worker**. A crash
between the pane creation and the receipt leaves a launch attempt without a
receipt. The recovery finds the live worker by its command line, which
carries the `--session-dir` of the worker. A worker that the recovery does not
find leaves the attempt unresolved. The attempt holds no counted capacity.
The recovery raises one `unresolved_launch` event, so the owner finds the
attempt in `wezterm_worker_status`. The owner settles it with
`wezterm_worker_resolve`. The resolution `abandoned` and the resolution
`incomplete` free the attempt. The resolution `recorded_result` is refused
for this event, because the worker of that launch never reported a result.
The extension never sends the launch command again.

**A finished worker continues with `--resume`, not with steering.**
Steering needs a live pane, and a completed worker has none.
`wezterm_worker_resume` starts `omp --resume <transcript>` in a fresh pane,
so the worker returns with its whole history and accepts a follow-up
instruction. The resumed run shares the transcript and the worktree of its
source run, so a resource group keeps a second writer out.

**The count starts at the newest user message.** A resumed transcript
already holds a finished turn. Thus a completion check over the absolute
counts reports the *previous* answer as the new result before the worker did
any work. Count assistant turns and tool calls only since the last user
message. You need at least one assistant turn in that window.

**A worker's worktree outlives the worker.** An isolated worker owns a `git
worktree` on branch `omp/worker/<jobId>`. The extension never removes it —
not on completion, not on cancel, not on timeout.

`wezterm_worker_cleanup` is
the only thing that removes one, and it checks `git status --porcelain`
first. A checkout with uncommitted changes or untracked files is **kept**. The
tool lists the changed paths, because those changes are the worker's output.
`force: true` discards them. The extension never deletes the branch, so
commits survive the worktree.

**The extension confirms a steering message. It never guesses.**
`herdr agent prompt` returns success when Herdr accepts the text. Thus the
extension sends the instruction once and reads the worker's transcript after
the send.

The transcript confirms the delivery only
when it records the requested text. Any other growth of the transcript is not
a confirmation. A delivery that the transcript does not confirm stays
unconfirmed, and the extension never sends the instruction again. A second
copy of the same instruction reaches the worker as a second instruction.

**The extension confirms a cancel and a deadline stop.** `herdr pane close`
returns success when Herdr accepts the request, not when the pane is gone. The
extension polls the pane list and ends the job only when the pane is gone. An
unreadable list means unknown, never gone. An unconfirmed stop leaves the job
`running`. Call `wezterm_worker_cancel` again to retry.

**The code enforces the limits.** Three workers are active at most by default
(`maxActiveWorkers`). The count does not include the main session. One request
launches at
most three workers (`maxLaunchesPerRequest`). A worker cannot launch a worker.

A refused launch returns an error that names the rule. Set the limits in the
config file when you need more. A user prompt starts a new request.

**The tool measures the tokens.** `wezterm_worker_status` shows the
tokens of each worker and of the request, read from the transcripts. The value
`unknown` means that the transcript holds no usage data. Report it as unknown.
The count does not include the main session.

## Running workers: traps that cost time

Each item below came from a real run.

**Do not put the path of the owner checkout in a task.** An isolated worker
starts in its own worktree. A task that says "work in `D:/repos/<repo>`" makes the
worker write there. Two workers did this and changed the checkout of the owner.
Write "work only in your current directory" and use relative paths. After the
first edit of a worker, run `git status` in the owner checkout.

**A report of a clean lint is not evidence.** Two workers reported a clean
`biome check` and left an import in the wrong order and an unused import. Run
the check yourself on the branch of the worker.

**Ask for the first red test early.** One worker analysed for 62 minutes and
made no commit. One steering message later it made a commit within 10 minutes.
Put a time limit for the first test in the task. The deep analysis was still
correct, so do not read a late commit as a wrong result.

**Run one `npm run check` for a merge of several branches.** Merge the
branches into one branch, resolve the conflicts, and run the check once on the
result. Conflicts in `package.json` (the long `test:unit` line),
`GLOSSARY.md` and the list of documents keep both sides. Two branches can pick
the same ADR number.

**`gh pr merge --rebase` drops merge commits.** Build a linear branch with
`git cherry-pick` first. Compare its tree with the tree that passed the check.
The diff must be empty. Then the check does not need a second run.

**A Herdr call can hang.** If `herdr pane list` or `herdr pane close` returns
nothing for minutes, stop a worker by the process id. Find the id from the
command line, which holds the run id. A hung `herdr` process can stay behind
and must be stopped too.

**Remove a `node_modules` junction with `cmd /c rmdir`.** `rm` does not remove
the link in Git Bash. The first removal looked successful and the link stayed.
Never delete through the link.

**A restart in the same window keeps the session id and changes the process.**
One measured restart left the old process alive as the parent of the new one.
The ownership row of a running worker kept the old process. The new process saw
the worker as read-only. The fix of issue 121 lets a session take its task back
when no process holds the lease of the session. That restart ran before the
fix, so nobody has measured the fix yet. Do not stop the old process: it can be
the parent of your window. Until a run proves the fix, read the worker from its
branch and from the database.

**A limit in the config file needs an OMP restart.** The change of
`maxActiveWorkers` did nothing until OMP started again.

**A relative path in `git worktree add` resolves against the current directory.**
A path that began with the wrong drive created a folder on drive D. Use absolute
paths.

## Extension runtime rules (OMP)

From the official extension docs (`can1357/oh-my-pi` → `docs/extensions.md`):

- **The extension factory parameter is `pi` and its type is
  `ExtensionAPI`.** That is the host's own convention, not a legacy name.
- **Do not call any action method while the extension loads.**
  `pi.sendMessage()` and
  friends throw `ExtensionRuntimeNotInitializedError` while the factory runs.
  Register first. Do the runtime work from `pi.on("session_start", ...)`, a
  command, or a tool.
- **Background work must use `ctx.setInterval`, not a raw `setInterval`.**
  Extensions run in-process with no isolation. A throw in a raw timer callback
  becomes a process-level `uncaughtException`. It then stops the **whole
  session**. `ctx.setInterval` contains the failure, is `unref`'d, and the host
  clears it automatically on `session_shutdown`.
- **`pi.setLabel(label)`** sets the extension's display label. It is not a
  session-entry labelling action.
- `pi.zod` is the schema builder. `pi.registerTool`, `pi.registerCommand` and
  `pi.on` are the registration methods.
- **OMP loads the extension again for each subagent in the same process.**
  Module-level variables stay shared across those loads. A handler of
  `session_start` or `session_shutdown` must return early for `sub`. The main
  session sets the shared message channel after the `session_start` guard.
  A subagent never sets this channel. A host without `ctx.agent` counts as
  `main`. The extension follows this rule (ADR 0014). A subagent can read worker
  status, pane text and results. It can start a worker without taking the main
  session. It cannot steer, cancel, acknowledge, release, take over, resolve,
  clean up or resume a worker. Each control tool refuses before it reads worker
  state or accesses a pane.

## The worker channel

The main session and one worker share a worker channel. A channel note is a
short piece of free text. A note changes no state of the task. A note never
steers a worker, and the extension never wakes the main session for a note.

The main session writes a note with `wezterm_worker_note_to_worker`. It reads
the notes of the worker with `wezterm_worker_notes_from_worker`. The worker
writes a note with `wezterm_worker_note_to_main`. It reads the notes of the
main session with `wezterm_worker_notes_from_main`. The last two tools are
worker-only. A main session never gets them.

A read is stateless. Pass the number of the last note that you read, or 0 for
the first read. The reply names the highest number of the channel. A note
holds 4000 characters at most, and an empty note is refused.

The worker reads the channel at the start of each instruction cycle and
before it reports `completed`. The bootstrap prompt tells it that rule. A
main session that wants the worker to read a note soon must steer it. A note
alone does not start a turn of the worker.

The delivery of a finished worker carries the 10 newest worker notes. One
line names the older notes and the tool that reads them. The status tool shows
one count line per worker, for example `notes: 3 from worker, 1 to worker`.
It shows no note text.

A Claude Code worker has a channel. Its mod reads the channel through the
bridge of the run, and it writes a note through the same bridge. A note of
the main session reaches that worker as its next prompt, with the label
`Note from the main session:`. The note reaches the worker one time. The turn
of a note is not an instruction cycle, so the note changes no state of the
task. The four tools work for every backend, so the main session never needs
to know the backend of a worker.

## The domain vocabulary

The repository holds a glossary at `GLOSSARY.md`. It names the terms of
this domain: **worker**, **result**, **preamble**, **turn**, **steering
message**, **resume**, **transcript**, **delivery**, **registry**,
**worktree**, **worker channel**, **channel note**. It also names the
supervision terms: **report**, **task state**, **execution condition**,
**instruction cycle**, **execution record**, **resource group**,
**launch attempt**, **unresolved launch**, **owner resolution**, **release**,
**drain**. Use these words. A term with a second name makes the next reader
guess. The words board, message and agent name other things, so they stay out
of the name of the channel.

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
- Use one instruction in each sentence.
- Use the active voice and name the actor.
- Use simple tenses. Write "the worker reads the file", not "the worker is
  reading the file".
- Keep the articles. Write "the file", not "file".
- Use "must" and "can". Write "must" where a rule applies.
- Limit a sentence to 20 words for a procedure. Limit a sentence to 25 words
  for a description.
- Delete filler words such as "simply" and "just".

Run `npm run ste100` in the repository. The command scores every document
that an agent reads with the checker of the ste100 skill. It fails below 80.

### The text that you send to a worker

The extension scores the `task` of a spawn, the `message` of a steer and the `result` of a report. The setting `commsStandard` in the config file sets the mode and the minimum score. The default is mode `warn` and score 80.

- Write the `task` and the `message` in English. The check skips a text that is mostly Vietnamese.
- Use one instruction in each sentence. Keep each sentence to 20 words or fewer.
- Name the file, the command and the expected output.
- In mode `warn`, a low score adds one line to the reply. The line holds the score only. The findings are in `details.commsCheck`.
- In mode `enforce`, the tool refuses a low score and lists the findings. Rewrite the text and send it again.
- The check starts the checker of the ste100 skill. The setting `ste100Skill` names the folder of the skill. The default is `~/.claude/skills/ste100`.
- A machine without the skill gives the verdict `skipped`. The reply names the skill and its folder. The tool never refuses a text then.
