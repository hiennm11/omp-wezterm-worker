# The removal of a worktree waits for its empty directory

The forced cleanup of an isolated worker failed on Windows. The reply said
`worktree NOT removed (failed to delete '<path>': Permission denied)`. The
integration tests `worktree.integration.test.ts` and
`mixed-backends.integration.test.ts` failed at the same assertion. Issue 239
records the measurements.

## The cause

`git worktree remove --force` deletes the files and the registration of the
worktree. Then it fails on the directory itself, because a process holds the
directory as its working directory. A probe scanned the working directory of
every process while the directory was still there. It found four processes:
the MCP servers `work-mcp`, `officecli` and `notebooklm-mcp` with its python
child. The OMP daemon started them in the working directory of the worker.
They stayed alive after the pane closed. The directory became free after 16
seconds in the measured run.

A second `git worktree remove` cannot finish the job. It answers `is not a
working tree`, because git no longer lists the path.

## The choice

`removeWorktree` still runs `git worktree remove --force` once. When git fails,
the function checks three facts:

1. The path is a directory with no entry in it.
2. `git worktree list --porcelain` does not list the path.
3. The wait of 30 seconds has not passed.

When the first two facts hold, the function calls `rmdirSync` on the path and
repeats it every 250 ms while the error is `EBUSY`, `EPERM` or `ENOTEMPTY`.
`rmdirSync` is not recursive, so the call can never delete a file. When the
wait ends, the function reports the first error of git as before. The caller
keeps the path and the note `worktree NOT removed`.

The wait is bounded and runs only after git removed the files. A directory
that holds a file, and a directory that git still lists, are never touched.
This keeps ADR 0002: the extension never deletes the work of a worker behind
git.

## What this change does not prove

This change does not find a way to stop the MCP servers from holding the
directory. It waits for them. The 16 seconds come from one machine and one
set of MCP servers. A machine with a slower server can need more than 30
seconds. In that case the reply names the path, and the owner removes it.

The tests prove the wait with a real process that holds a directory. They do
not prove the fix against the OMP daemon. The test
`worktree.integration.test.ts` does.
