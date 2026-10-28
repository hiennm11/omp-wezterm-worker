# The extension never deletes a worker's work

The extension never removes the worktree of an isolated worker. The extension
never removes its branch. The worker may commit, edit or create files. Those
files are the output of the worker. Deleting them on completion, cancellation
or timeout breaks work the user never saw.

`wezterm_worker_cleanup` is the only tool that removes a worktree. The tool
checks the checkout first. The tool keeps a worktree with uncommitted changes
or untracked files. The tool reports the changed paths. `force: true`
discards them deliberately.

The extension never removes the branch at all. The commits survive the
removal of the checkout.

The cost is that worktrees collect under the state directory. The cost is
also that the branch of each worker stays in the repository. This cost is
deliberate. A worktree that nobody uses is only storage. The user loses the
work of a deleted worktree.
