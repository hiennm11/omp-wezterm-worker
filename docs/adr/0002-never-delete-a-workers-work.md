# The extension never deletes a worker's work

An isolated worker's worktree and its branch are never removed by the
extension. The worker may have committed, edited or created files; that is its
output, and deleting it on completion, cancellation or timeout destroys work
the user never saw.

`wezterm_worker_cleanup` is the only thing that removes a worktree, and it
checks the checkout first: a worktree with uncommitted changes or untracked
files is kept and the changed paths are reported. `force: true` discards them
deliberately. The branch is never deleted by the extension at all, so commits
survive the removal of the checkout.

The cost is that worktrees accumulate under the state directory and branches
accumulate in the repository. That is deliberate: an unused worktree is
storage, a deleted one is lost work.
