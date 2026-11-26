/**
 * Git worktree isolation.
 *
 * An isolated worker runs in its own checkout on its own branch, so parallel
 * workers never edit the same files.
 */

import { existsSync, mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { delay, describeFailure } from "./process.ts";
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

/** The longest wait for a process to let go of the empty directory of a removed worktree. */
export const WORKTREE_DIR_WAIT_MS = 30_000;

/** The pause between two attempts to remove the empty directory. */
const WORKTREE_DIR_RETRY_MS = 250;

/** The errors that mean a process still holds the directory. */
const HELD_CODES: Record<string, true> = { EBUSY: true, EPERM: true, ENOTEMPTY: true };

/** True when the path is a directory with no entry in it. */
function isEmptyDir(path: string): boolean {
	try {
		return readdirSync(path).length === 0;
	} catch {
		return false;
	}
}

/** True when git still lists the path as a worktree of the repository. */
async function gitListsWorktree(rt: WorkerRuntime, cwd: string, path: string): Promise<boolean | null> {
	const res = await rt.git(cwd, ["worktree", "list", "--porcelain"]);
	if (res.code !== 0) return null;
	const wanted = resolve(path).toLowerCase();
	return res.stdout
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.some((line) => resolve(line.slice("worktree ".length).trim()).toLowerCase() === wanted);
}

/**
 * Remove the empty directory that git left behind.
 *
 * On Windows `git worktree remove` deletes the files and the registration,
 * then fails on the directory itself while a process holds it as its working
 * directory. A measured run showed the MCP servers of the OMP daemon, started
 * in the working directory of the worker, holding it for about 16 seconds
 * after the pane closed.
 *
 * The function removes only a directory that is empty and that git no longer
 * lists. `rmdirSync` is not recursive, so it can never delete a file.
 */
async function removeLeftoverDir(
	rt: WorkerRuntime,
	cwd: string,
	path: string,
	waitMs: number,
): Promise<boolean> {
	if (!isEmptyDir(path)) return false;
	if ((await gitListsWorktree(rt, cwd, path)) !== false) return false;
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			rmdirSync(path);
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (code === "ENOENT") return true;
			if (!Object.hasOwn(HELD_CODES, code) || Date.now() >= deadline) return false;
		}
		await delay(WORKTREE_DIR_RETRY_MS);
	}
}

/**
 * Remove a worker's isolated worktree.
 *
 * The worker's pane keeps the directory open, so the removal only succeeds
 * after that pane is gone. Returns the removal outcome instead of throwing.
 *
 * The directory is never deleted behind git's back: when git refuses, the
 * worktree stays and the caller reports why. The one exception is an empty
 * directory that git no longer lists. The function waits for it up to
 * `waitMs`, because a process can still hold it. Removing the branch is a
 * separate decision and is never taken here.
 */
export async function removeWorktree(
	rt: WorkerRuntime,
	cwd: string,
	path: string,
	waitMs: number = WORKTREE_DIR_WAIT_MS,
): Promise<{ removed: boolean; error: string | null }> {
	const res = await rt.git(cwd, ["worktree", "remove", "--force", path]);
	if (res.code === 0) return { removed: true, error: null };
	if (await removeLeftoverDir(rt, cwd, path, waitMs)) return { removed: true, error: null };
	return { removed: false, error: describeFailure(res) };
}
