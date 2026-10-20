/**
 * Git worktree isolation.
 *
 * An isolated worker runs in its own checkout on its own branch, so parallel
 * workers never edit the same files.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { describeFailure } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";

export async function createWorktree(
	rt: WorkerRuntime,
	cwd: string,
	jobId: string,
): Promise<{ path: string; branch: string }> {
	const inside = await rt.git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside.code !== 0 || inside.stdout.trim() !== "true") {
		throw new Error(`Isolation requested but cwd is not a git repository: ${cwd}`);
	}
	const base = join(rt.config.stateDir, "worktrees", jobId);
	mkdirSync(join(rt.config.stateDir, "worktrees"), { recursive: true });
	const branch = `omp/worker/${jobId}`;
	const res = await rt.git(cwd, ["worktree", "add", "-b", branch, base, "HEAD"]);
	if (res.code !== 0) {
		throw new Error(`git worktree add failed: ${describeFailure(res)}`);
	}
	return { path: base, branch };
}

/**
 * Look at a worktree before it is removed.
 *
 * A worker may have committed nothing and still leave uncommitted edits,
 * untracked files or stashes behind. Those are the worker's output, so the
 * worktree is only safe to remove when the checkout is clean.
 */
export async function inspectWorktree(
	rt: WorkerRuntime,
	path: string,
): Promise<{ exists: boolean; clean: boolean; changes: string[] }> {
	if (!existsSync(path)) return { exists: false, clean: true, changes: [] };
	const res = await rt.git(path, ["status", "--porcelain"]);
	if (res.code !== 0) {
		// An unreadable status means the state is unknown, so it is not clean.
		return {
			exists: true,
			clean: false,
			changes: [(res.stderr || res.stdout || "git status failed").trim()],
		};
	}
	const changes = res.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	return { exists: true, clean: changes.length === 0, changes };
}

/**
 * Remove a worker's isolated worktree.
 *
 * The worker's pane keeps the directory open, so the removal only succeeds
 * after that pane is gone. Returns the removal outcome instead of throwing.
 *
 * The directory is never deleted behind git's back: when git refuses, the
 * worktree stays and the caller reports why. Removing the branch is a
 * separate decision and is never taken here.
 */
export async function removeWorktree(
	rt: WorkerRuntime,
	cwd: string,
	path: string,
): Promise<{ removed: boolean; error: string | null }> {
	const res = await rt.git(cwd, ["worktree", "remove", "--force", path]);
	if (res.code === 0) return { removed: true, error: null };
	return { removed: false, error: describeFailure(res) };
}
