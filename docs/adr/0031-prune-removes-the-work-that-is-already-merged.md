# The prune removes the work that is already merged

Status: accepted. The owner chose this design on 2026-11-16.

## Context

The state directory of the plugin held 19 worktrees and 848 MB after four
weeks of use. The repository held 40 local branches. The user removed 17
worktrees by hand.

The hand check used `git cherry` and not the sha of the commit. The
repository merges with `gh pr merge --rebase`. A rebase changes the sha of
every commit of the branch. A check of the sha would keep work that the
merge already holds, and it could delete work that the merge does not hold.

ADR 0002 says that the extension never removes a branch. This decision
changes that rule in one narrow case.

## The decision

The tool `wezterm_worker_prune` removes the worktree and the branch of the
old workers whose work the target branch already holds.

### The default is a dry run

The tool changes nothing until the user passes `dryRun: false`. A dry run
lists every worker that needs a decision and names the worker that a real run
would remove. The user sees the result before anything goes.

The report does not name a worker that holds no worktree, and it does not
name a worker whose worktree is gone from the disk and that holds no branch.
The report counts these workers in one summary line.

### The candidate

A worker is a candidate when all of these hold:

- the worker ended and it ended at least `olderThanDays` days ago
- the worker holds a worktree
- the worktree has no uncommitted change, no untracked file and no stash
- `git cherry <into> <branch>` prints no line that starts with `+`

A line that starts with `-` means that the patch is already in the target
branch. The command compares the patches and not the shas.

### The target branch

The target branch is the parameter `into`. The default is the target of
`refs/remotes/origin/HEAD` of the repository of the worker. A repository
without that ref keeps its workers, and the message names `into`.

### The order of the work

The tool checks the candidate, then it runs the cleanup path of the worker,
then it deletes the branch. The cleanup path is the path of the tool
`wezterm_worker_cleanup`. Both tools call the same function, so both tools
use the same gates. A worker that a gate refuses keeps its worktree and its
branch, and the other workers go on.

### The deletion of the branch

The tool deletes the branch with `git branch -D`. The command is correct
here because a rebase merge leaves the branch unmerged for `git branch -d`.
The tool deletes the branch only after the check of the patches, and only
when no other worktree has the branch.

## Consequences

ADR 0002 stays true for every other path. The tool `wezterm_worker_cleanup`
never removes a branch. The force of that tool never removes a branch. The
prune removes a branch only after `git cherry` shows that every patch of the
branch is in the target branch.

The prune never forces. A worktree with changes is never removed by the
prune. The commits of a worker that the target branch does not hold survive
the prune, because the check of the patches refuses the worker.

The prune removes the transcript directory of the worker too, because the
cleanup path removes it. The user loses the transcript of a pruned worker.
The result of a worker is in the main session, and the transcript of an old
worker has no value after the merge.

The prune reads the repository of each worker. A repository that the tool
cannot read keeps its workers, and the report names the reason.
