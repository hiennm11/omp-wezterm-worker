/**
 * The decision of the prune.
 *
 * The prune removes the worktree and the branch of a worker whose work is
 * already in the target branch. The decisions here are functions of the
 * worker, the clock and the repository, so a test can check them with a real
 * repository and without a pane.
 *
 * The prune never forces. A worker that holds work keeps its worktree and
 * its branch.
 */

import { cleanupJob } from "./cleanup-action.ts";
import type { Job } from "./job.ts";
import { describeFailure } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { inspectWorktree } from "./worktree.ts";

/** The number of milliseconds of one day. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The default number of days that a worker must be old. */
export const DEFAULT_OLDER_THAN_DAYS = 7;

/** The state of a worker after the prune. */
export type PruneState = "removed" | "would-remove" | "kept";

/** The reason why the report of the prune skips a worker. */
export type PruneSkip = "no-worktree" | "gone-worktree";

/** One worker of the report of the prune. */
export interface PruneResult {
	workerId: string;
	state: PruneState;
	reason: string;
	/** The reason why the report skips the worker, or null when it names the worker. */
	skip: PruneSkip | null;
}

/** The decision about one worker. */
interface PruneDecision {
	/** True when the worker can be a candidate of the prune. */
	eligible: boolean;
	/** The reason why the worker is not a candidate, or null. */
	reason: string | null;
	/** The reason why the report skips the worker, or null when it names the worker. */
	skip: PruneSkip | null;
}

/**
 * Decide whether a worker is a candidate of the prune.
 *
 * A candidate is a worker that ended, that is old enough, and that holds a
 * worktree. The checks of the checkout and of the commits need the
 * repository, so they sit in `pruneWorker`.
 */
function pruneDecision(job: Job, now: number, olderThanDays: number): PruneDecision {
	if (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled") {
		return { eligible: false, reason: `it is still ${job.status}`, skip: null };
	}
	if (job.finishedAt === null) {
		return { eligible: false, reason: "it has no end time", skip: null };
	}
	if (now - job.finishedAt < olderThanDays * DAY_MS) {
		return { eligible: false, reason: `it is younger than ${olderThanDays} days`, skip: null };
	}
	if (job.worktreePath === null) {
		return { eligible: false, reason: "it has no worktree", skip: "no-worktree" };
	}
	return { eligible: true, reason: null, skip: null };
}

/**
 * A worker that the prune keeps.
 *
 * The parameter `skip` names the reason why the report skips the worker.
 */
function kept(workerId: string, reason: string, skip: PruneSkip | null = null): PruneResult {
	return { workerId, state: "kept", reason, skip };
}

/**
 * The default target branch of a repository.
 *
 * The target is the branch that the repository names as its default. The
 * function returns null when the repository names none.
 */
async function defaultTargetBranch(rt: WorkerRuntime, repo: string): Promise<string | null> {
	const res = await rt.git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	if (res.code !== 0) return null;
	const name = res.stdout.trim();
	return name.length > 0 ? name : null;
}

/**
 * Check that every patch of the branch is already in the target.
 *
 * The command `git cherry` compares the patches, not the shas. A rebase
 * merge changes the sha of every commit, so a comparison of the shas would
 * keep merged work and could delete unmerged work.
 */
async function cherryHolds(
	rt: WorkerRuntime,
	repo: string,
	into: string,
	branch: string,
): Promise<{ holds: boolean; reason: string | null }> {
	const res = await rt.git(repo, ["cherry", into, branch]);
	if (res.code !== 0) {
		return { holds: false, reason: `the commits of ${branch} cannot be compared: ${describeFailure(res)}` };
	}
	const missing = res.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("+"));
	if (missing.length > 0) {
		return { holds: false, reason: `its commits are not in ${into} (${missing.length} missing)` };
	}
	return { holds: true, reason: null };
}

/**
 * The stashes of a worktree.
 *
 * The command reads the stashes of the repository. A repository with the
 * setting `extensions.worktreeConfig` keeps a stash in the worktree that
 * made it, so the command runs in the worktree of the worker.
 */
async function stashesOf(
	rt: WorkerRuntime,
	worktree: string,
): Promise<{ stashes: string[]; error: string | null }> {
	const res = await rt.git(worktree, ["stash", "list"]);
	if (res.code !== 0) return { stashes: [], error: describeFailure(res) };
	const stashes = res.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return { stashes, error: null };
}

/**
 * The worktree that has the branch, or null when no worktree has it.
 *
 * The command `git worktree list --porcelain` prints one block per worktree.
 * The block starts with the path of the worktree.
 */
async function branchCheckedOut(
	rt: WorkerRuntime,
	repo: string,
	branch: string,
): Promise<{ checkedOut: boolean; path: string | null; error: string | null }> {
	const res = await rt.git(repo, ["worktree", "list", "--porcelain"]);
	if (res.code !== 0) return { checkedOut: false, path: null, error: describeFailure(res) };
	for (const block of res.stdout.split("\n\n")) {
		const lines = block.split("\n").filter((line) => line.length > 0);
		const branchLine = lines.find((line) => line.startsWith("branch "));
		if (branchLine !== `branch refs/heads/${branch}`) continue;
		const pathLine = lines.find((line) => line.startsWith("worktree "));
		return { checkedOut: true, path: pathLine?.slice("worktree ".length) ?? null, error: null };
	}
	return { checkedOut: false, path: null, error: null };
}

/**
 * True when the repository holds the branch.
 *
 * A command that fails leaves the answer unknown, so the function returns
 * true. The caller then keeps the worker on the list.
 */
async function branchExists(rt: WorkerRuntime, repo: string, branch: string): Promise<boolean> {
	const res = await rt.git(repo, ["branch", "--list", branch]);
	if (res.code !== 0) return true;
	return res.stdout.trim().length > 0;
}

/**
 * Delete a branch of a repository.
 *
 * The command is `git branch -D`, because a rebase merge leaves the branch
 * unmerged for `git branch -d`. The caller checks the patches first.
 */
async function deleteBranch(
	rt: WorkerRuntime,
	repo: string,
	branch: string,
): Promise<{ deleted: boolean; reason: string | null }> {
	const res = await rt.git(repo, ["branch", "-D", branch]);
	if (res.code === 0) return { deleted: true, reason: null };
	const list = await rt.git(repo, ["branch", "--list", branch]);
	if (list.stdout.trim().length === 0) {
		return { deleted: true, reason: `the branch ${branch} was already gone` };
	}
	return { deleted: false, reason: describeFailure(res) };
}

/** The options of the prune of one worker. */
export interface PruneOptions {
	/** The branch that must hold the work. Null asks for the default. */
	into: string | null;
	/** True when the tool changes nothing. */
	dryRun: boolean;
	/** The time of the run. */
	now: number;
	/** The number of days that a worker must be old. */
	olderThanDays: number;
}

/**
 * Prune one worker.
 *
 * The order of the work is the order of the design: the checks of the
 * candidate, then the cleanup of the worker, then the deletion of the
 * branch. The function never throws. A worker that the prune cannot handle
 * is kept, and the reason says why.
 */
export async function pruneWorker(rt: WorkerRuntime, job: Job, options: PruneOptions): Promise<PruneResult> {
	const decision = pruneDecision(job, options.now, options.olderThanDays);
	if (!decision.eligible) return kept(job.id, decision.reason ?? "it is not a candidate", decision.skip);

	const repo = job.worktreeOrigin ?? job.cwd;
	const branch = job.worktreeBranch;
	if (branch === null) return kept(job.id, "it has no branch");
	if (job.worktreePath === null) return kept(job.id, "it has no worktree", "no-worktree");

	const into = options.into ?? (await defaultTargetBranch(rt, repo));
	if (into === null) {
		return kept(
			job.id,
			"the repository has no default branch. Pass into to name the branch that must hold the work.",
		);
	}

	const state = await inspectWorktree(rt, job.worktreePath);
	if (!state.exists) {
		/* The worktree is gone. The branch of the worker may still exist, so
		   the worker needs a decision. A worker without a branch has nothing
		   to remove, so the report skips it. */
		if (await branchExists(rt, repo, branch)) {
			return kept(job.id, "its worktree is gone from the disk");
		}
		return kept(job.id, "its worktree is gone from the disk", "gone-worktree");
	}
	if (!state.clean) {
		return kept(job.id, `it has uncommitted changes (${state.changes.length})`);
	}
	const stashes = await stashesOf(rt, job.worktreePath);
	if (stashes.error) return kept(job.id, `the stashes cannot be read: ${stashes.error}`);
	if (stashes.stashes.length > 0) {
		return kept(job.id, `it has ${stashes.stashes.length} stash(es)`);
	}

	const cherry = await cherryHolds(rt, repo, into, branch);
	if (!cherry.holds) return kept(job.id, cherry.reason ?? `its commits are not in ${into}`);

	if (options.dryRun) {
		return {
			workerId: job.id,
			state: "would-remove",
			reason: `its work and its branch are in ${into}`,
			skip: null,
		};
	}

	const outcome = await rt.runAction(`cleanup:${job.id}`, () => cleanupJob(rt, job, false));
	if (outcome.refusal) return kept(job.id, outcome.refusal.text);
	if (!outcome.worktreeGone) {
		return kept(job.id, outcome.notes.join(" "));
	}

	const checkedOut = await branchCheckedOut(rt, repo, branch);
	if (checkedOut.error) {
		return {
			workerId: job.id,
			state: "removed",
			reason: `worktree removed; the branch ${branch} stays: ${checkedOut.error}`,
			skip: null,
		};
	}
	if (checkedOut.checkedOut) {
		return {
			workerId: job.id,
			state: "removed",
			reason: `worktree removed; the branch ${branch} stays because the worktree ${checkedOut.path ?? "of another worker"} has it`,
			skip: null,
		};
	}
	const deletion = await deleteBranch(rt, repo, branch);
	if (!deletion.deleted) {
		return {
			workerId: job.id,
			state: "removed",
			reason: `worktree removed; the branch ${branch} stays: ${deletion.reason}`,
			skip: null,
		};
	}
	return {
		workerId: job.id,
		state: "removed",
		reason: `worktree removed; the branch ${branch} deleted`,
		skip: null,
	};
}
