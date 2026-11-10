# The Codex backend is removed

Status: accepted design. The owner accepted it on 2026-11-10.

## Context

ADR 0010 introduced the native backends. ADR 0012 described the Codex
backend, with its app server, its TUI and its report channel.

The owner does not use the Codex backend. The backend cost one smoke run and
58 test and tooling files. The files of the backend made the repository hard
to change, because every shared module knew about the app server and its
TUI.

The 58 files are the files of `tests/` and of `tooling/` whose name holds
`codex`. The change deletes 79 files in total. The other 21 files are the
modules of the backend, the fixtures of the tests and the scripts of the
repository.

The removal changes the schema of the spawn tool. The parameter `backend` no
longer names `codex`.

## The decision

The Codex backend is removed. The value `codex` leaves the type
`WorkerBackend`, the list `KNOWN_BACKENDS` and the list `IMPLEMENTED_BACKENDS`.
The spawn tool names only `omp` and `claude`.

A spawn that names `codex` is refused before the launch. The reply names the
known backends, so the user sees which values the extension accepts.

A run that the database holds with the value `codex` still loads. The value
stays in the column `payload` of the table `runs`, so the schema of the
database does not change. The format of `registry.json` does not change
either.

Such a run never starts, resumes, steers or cancels. The status tool lists it
as an ended run. The row names the backend `Codex`, so the run never looks
like a run of OMP. Every tool that gets such a run replies with the sentence
`This run used the Codex backend. The Codex backend was removed.`

A config file that still holds `codexBin` or a section `codex` does not break
the extension. The loader ignores both and gives one guidance line that names
the ignored key.

The ADR 0012, ADR 0020 and ADR 0021 stay in the repository. They record the
history of the backend. Each file names ADR 0026 at the top.

## What is lost

The extension can no longer run a worker in Codex CLI. A user of Codex CLI has
no worker backend.

The proof of the Codex backend is gone. The smoke run of the backend is gone.

The git history keeps the code. The branch `chore/remove-codex` holds the
commit that removes it, and the commit before that commit holds every module
of the backend. A reader of the history finds the whole implementation of the
app server, the TUI, the report channel and the proof.

## The reason

The owner does not use the Codex backend. The backend cost one smoke run and
58 test and tooling files.

## What this keeps

The Claude backend stays. The OMP backend stays. The Herdr code stays. The
Claude refusal on Herdr stays.

ADR 0010 stays. ADR 0009 stays. The evidence rules, the event model and the
rule that the extension never answers a native dialog stay.
