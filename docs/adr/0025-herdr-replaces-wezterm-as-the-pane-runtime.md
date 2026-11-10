# Herdr replaces WezTerm as the pane runtime

The extension opens each worker pane with `wezterm cli`. Herdr 0.9.5 does the same work through a local API. This ADR records the decision to replace WezTerm with Herdr. It also records what the measurements showed. The code changes follow in separate batches.

## Why

Two reasons count.

- `agent.prompt` sends the text and the Enter key in one call. The extension no longer needs `send-text --no-paste` and the composer settle delay.
- Herdr reports the state of an agent: `idle`, `working` or `blocked`. The monitor depends less on the transcript.

Speed is not a reason. A `herdr pane list` call takes 44 ms. The start of `wezterm` takes 45 ms. Both times are the start of a process.

## What the measurements showed

The runs used Herdr 0.9.5 on Windows in throwaway sessions. The table says which facts a run proved and which facts come from the source only.

| Fact | Evidence |
|---|---|
| The raw socket answers only the first request of a connection. The CLI opens one connection for each command. | Run |
| `agent.prompt` during an OMP turn returns at once. The agent stays `working`. OMP queues the text. The session file holds a second user message after the turn. | Run |
| `agent.start` with `kind: omp` gives the task to OMP as one user message. A task with quotes stays one element. | Run |
| `agent.start` with `kind: claude` keeps `say "A B" $(x) & y` as one argv element. | Run |
| `agent.start` with `kind: codex` and a bare prompt times out, because Codex wants its background daemon. The real argv of this extension was not tried. | Run, inconclusive |
| `layout.apply` with a `pane` leaf and a `command` array keeps each argv element. The `env` arrives. | Run |
| `layout.apply` with the `tab_id` of an existing tab opened a new tab. The old pane left the pane list. A later `pane.split` on that pane failed with `pane_not_found`. | Run |
| `pane.run` joins its words into one string for the shell of the pane. | Source only |
| After `herdr server stop` the `omp` process of a pane ends. After the server starts again, Herdr restores the layout and runs `omp --resume=<session file>` by itself. The pane ids and the agent names stay. | Run |
| The command line that Herdr restores has no `--session-dir` and no `--append-system-prompt`. | Run |

## The decision

The extension uses Herdr and no longer uses WezTerm. It keeps one seam for the pane runtime. The seam is `rt.herdr`. The seam `rt.wezterm` and the key `weztermBin` go away.

### The launch

The extension opens a pane with `pane.split` and passes `env` and `cwd`. Then it calls `agent.start` with the `kind` and the `args`. This keeps every argv element intact. It applies to the OMP worker and to the Claude Code worker.

The extension opens a new tab with `layout.apply` and no `tab_id`. The Codex app server pane uses the same call, because the server is not an agent.

The extension never uses `pane.run`. It never gives `tab_id` to `layout.apply`. A `tab_id` replaces the panes of that tab, so the call could close the pane of the main session.

The Codex TUI pane stays open to measurement. The batch for the Codex backend must measure `agent.start` with `--remote ws://127.0.0.1:<port> resume <threadId>` first. Until then, no document may claim that the TUI uses `agent.start`.

### The binary keys

`agent.start` selects the program by `kind` from the `PATH`. The keys `ompBin`, `claudeBin` and `codexBin` stay, because the extension uses them for work that is not a launch:

- the version check of OMP before a spawn;
- the check and the plugin validation of Claude Code;
- the search for the Codex program, and the command of the Codex app server.

The cost is a split. A key that names a custom path changes the check, but it does not change the program that Herdr starts for an OMP worker or a Claude worker. The README must say that such a program has to come first on the `PATH`.

### The steering message

`agent.prompt` replaces `send-text --no-paste`. A steering message that arrives during a turn waits in the queue of the agent. The extension still confirms the delivery from the transcript, as ADR 0006 and the skill say. The composer settle delay goes away.

### The pane id

The pane id becomes a string such as `w4:p1`. The extension keeps the id that Herdr returns and never builds an id. Herdr has no window id. The field `windowId` of a job stays and always holds null.

### The database

The column `pane_id` of `runs` and of `launch_attempts` changes from `INTEGER` to `TEXT`. `SCHEMA_VERSION` goes from 1 to 2. The repository has no runner for versioned steps today. A step runner must run before the import of the old registry. The step must also rewrite the pane id inside the stored job, because the job holds a JSON copy.

An old numeric id from WezTerm means that the pane is gone. The recovery that exists settles such a worker as `failed`. The extension does not map an id from one runtime to the other. The owner must let the running workers end before the upgrade.

### The session

The extension runs only inside a Herdr session. Herdr sets `HERDR_ENV=1` in every pane. A spawn outside a session is refused with a message that names the variable. The extension never starts a Herdr server.

### The names

The tools keep the names `wezterm_*`. The package name and the variables `WEZTERM_WORKER_*` stay. The parameter `placement` keeps the values `split` and `tab`. A rename needs its own ADR.

## The restart of the Herdr server

Herdr resumes agents after a restart of its server. The extension has its own resume (ADR 0009). Two systems can then resume one session.

The extension owns the resume. The user sets `session.resume_agents_on_restore = false` in the Herdr configuration. The extension never edits that file.

The setting is `true` by default. A file without the key therefore means `true`. `wezterm_worker_status` must warn when the key is `true` or when it is missing.

The measurement gives a second reason. The command line that Herdr restores has no `--session-dir` and no `--append-system-prompt`. A worker that Herdr resumes has no reporting contract.

One idea stays open. The extension could attach a worker to a pane that Herdr resumed. The issue tracker holds it as issue 163.

## What is not proven

- The measurement of the restart did not check the variable `OMP_WORKER_SESSION_DIR` in the resumed process.
- The guard `checkSourcePane` refuses a resume while the pane of the source run is open. The pane ids stay after a restart, so the guard probably stops the second resume. Nobody ran the guard against a Herdr pane.
- `agent.start` with the real Codex argv is not measured.
- The index of GitNexus is 134 commits behind. The impact counts of `launchProgram`, `paneState` and `finalizeJob` are CRITICAL. The counts must be read again after a new index.

## The accepted costs

- A worker that runs during the upgrade is lost. It settles as `failed`.
- The extension works only inside a Herdr session.
- The extension depends on a Herdr release that has native Windows support. Direct terminal attach and live server handoff do not work on Windows.
- An OMP worker and a Claude worker use the program that is first on the `PATH`.

## The rejected options

- Keep WezTerm and add Herdr. Every supervision rule would have to hold for two runtimes, and the tests would have to cover both.
- Launch with `pane.run`. It joins the words into one shell string and loses the argv.
- Launch every pane with `layout.apply`. The pane of the main session could close when a call names its tab.
- Use `agent.start` for every pane. The Codex app server is not an agent.
- Let Herdr own the resume. The restored command line has no reporting contract.
- Write the Herdr configuration for the user. The user owns that file.
