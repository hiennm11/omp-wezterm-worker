/**
 * The cleanup of one worker.
 *
 * The cleanup removes the worktree and the transcript of a worker that ended.
 * The tool `wezterm_worker_cleanup` and the tool `wezterm_worker_prune` call
 * this function, so both tools use the same gates.
 *
 * The function returns plain data. The caller builds the reply, so the tool
 * that calls it decides how the result looks.
 */

import { rmSync } from "node:fs";

import { cleanupRefusal, refusalDetails } from "./authority.ts";
import { pendingEvents } from "./events.ts";
import { freeEndedHolder } from "./group-holder.ts";
import { clearDisposing, groupOfRun, markDisposing } from "./groups.ts";
import { activeSharers, type Job } from "./job.ts";
import { taskKey } from "./owner.ts";
import { readOwnership } from "./ownership.ts";
import { paneState } from "./pane.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { stopIntentRefusal } from "./stop-reconcile.ts";
import { claimVacantTask } from "./vacant-task.ts";
import { inspectWorktree, removeWorktree } from "./worktree.ts";

/** A refusal that stops the cleanup. */
export interface CleanupRefusal {
	/** The text of the refusal. */
	text: string;
	/** The details of the refusal. */
	details: Record<string, unknown>;
}

/** The result of the cleanup of one worker. */
export interface CleanupOutcome {
	/** The refusal that stopped the cleanup, or null when the cleanup went on. */
	refusal: CleanupRefusal | null;
	/** The notes of the cleanup. */
	notes: string[];
	/** The path of the worktree that the cleanup kept, or null. */
	keptWorktree: string | null;
	/** The changed paths of the kept worktree. */
	keptChanges: string[];
	/** True when the job holds no worktree path after the cleanup. */
	worktreeRemoved: boolean;
	/** True when the worktree of the worker is gone, also when it was already gone. */
	worktreeGone: boolean;
	/** The branch of the worker before the cleanup. */
	branch: string | null;
}

/** The outcome of a cleanup that a refusal stopped. */
function stopped(refusal: CleanupRefusal, branch: string | null): CleanupOutcome {
	return {
		refusal,
		notes: [],
		keptWorktree: null,
		keptChanges: [],
		worktreeRemoved: false,
		worktreeGone: false,
		branch,
	};
}

/** What the release of a worktree did. */
interface WorktreeOutcome {
	notes: string[];
	kept: string | null;
	keptChanges: string[];
	gone: boolean;
}

/**
 * Release the worker's worktree, unless it holds work.
 *
 * Never throw away work. A checkout with uncommitted edits, untracked files or
 * stashes holds the worker's output, so it survives unless the caller forces
 * the removal.
 */
async function releaseWorktree(rt: WorkerRuntime, job: Job, force: boolean): Promise<WorktreeOutcome> {
	const path = job.worktreePath;
	if (!path) return { notes: [], kept: null, keptChanges: [], gone: true };

	const pane = job.paneId === null ? "gone" : await paneState(rt, job);
	if (pane === "present") {
		return {
			notes: [`worktree kept: close pane ${job.paneId} first, it holds the directory`],
			kept: path,
			keptChanges: [],
			gone: false,
		};
	}
	if (pane === "unknown") {
		return {
			notes: [
				`worktree kept: the pane list cannot be read, so pane ${job.paneId} may still hold the directory`,
			],
			kept: path,
			keptChanges: [],
			gone: false,
		};
	}

	const state = await inspectWorktree(rt, path);
	if (!state.exists) {
		return { notes: [`worktree already gone: ${path}`], kept: null, keptChanges: [], gone: true };
	}
	if (!state.clean && !force) {
		return {
			notes: [
				`worktree kept: it has uncommitted changes (${state.changes.length}). Keep it, or pass force to discard them.`,
				...state.changes.map((change) => `  ${change}`),
			],
			kept: path,
			keptChanges: state.changes,
			gone: false,
		};
	}

	const removal = await removeWorktree(rt, job.worktreeOrigin ?? job.cwd, path);
	if (!removal.removed) {
		return {
			notes: [`worktree NOT removed (${removal.error ?? "unknown"}): ${path}`],
			kept: path,
			keptChanges: [],
			gone: false,
		};
	}
	const notes = [`worktree removed: ${path}`];
	if (job.worktreeBranch) {
		notes.push(`branch kept (commits made by the worker survive): ${job.worktreeBranch}`);
	}
	job.worktreePath = null;
	job.worktreeBranch = null;
	return { notes, kept: null, keptChanges: [], gone: true };
}

/**
 * Release the resources of a worker that ended.
 *
 * The function runs every gate of the cleanup. A gate that fails returns a
 * refusal, and the caller reports it. The gates never change the resources
 * of a worker that another session owns, that another run holds, that waits
 * for an event of the owner, or that still holds work.
 */
export async function cleanupJob(rt: WorkerRuntime, job: Job, force: boolean): Promise<CleanupOutcome> {
	const branch = job.worktreeBranch;
	const owner = readOwnership(rt.openDb(), taskKey(job.id)).owner;
	/* A task of another session can be vacant. The claim takes the task when
	   the run ended and the owner process is gone. */
	await claimVacantTask(rt, job.id, owner);
	const claimed = readOwnership(rt.openDb(), taskKey(job.id)).owner;
	const refusal = cleanupRefusal(claimed, rt.sessionId, job.id);
	if (refusal) return stopped({ text: refusal, details: refusalDetails(job.id, claimed) }, branch);

	// A pending stop intent means that a destructive command may have
	// run. The cleanup must not act on a worker whose pane may
	// already be closed.
	const intentRefusal = stopIntentRefusal(rt.openDb(), job.id);
	if (intentRefusal) {
		return stopped({ text: intentRefusal, details: { workerId: job.id, stopIntent: "pending" } }, branch);
	}
	const sharers = activeSharers(rt.jobs.values(), job);
	if (sharers.length > 0) {
		const ids = sharers.map((other) => other.id);
		return stopped(
			{
				text:
					`Worker ${job.id} shares its transcript and worktree with active worker ${ids.join(", ")}. ` +
					"Cancel that worker first.",
				details: { workerId: job.id, activeSharers: ids },
			},
			branch,
		);
	}

	// The cleanup deletes the transcript and the worktree. The resource
	// group knows whether a run still holds them. The check uses the
	// stored records, not a scan of the process-local worker map.
	const db = rt.openDb();
	// The group belongs to the session directory of the task, so a
	// resumed run finds the group of the first run of the task.
	let group = groupOfRun(db, job);
	const groupId = group?.id ?? null;
	if (group) {
		if (group.executionState === "unknown") {
			return stopped(
				{
					text: `The state of the resources of worker ${job.id} is unknown. Resolve the worker first.`,
					details: {
						workerId: job.id,
						resourceGroup: group.id,
						executionState: group.executionState,
					},
				},
				branch,
			);
		}
		// A holder that ended keeps the group until its pane is gone.
		// The cleanup frees the group when the pane of the holder is
		// gone.
		const holderRefusal = await freeEndedHolder(rt, group);
		if (holderRefusal) {
			const holder = group.executionHolder === null ? undefined : rt.jobs.get(group.executionHolder);
			return stopped(
				{
					text: holderRefusal,
					details: {
						workerId: job.id,
						resourceGroup: group.id,
						executionHolder: group.executionHolder,
						pane: holder?.paneId ?? null,
					},
				},
				branch,
			);
		}
		group = groupOfRun(db, job) ?? group;
		if (group.executionHolder !== null && group.executionHolder !== job.id) {
			return stopped(
				{
					text: `The resources of worker ${job.id} are used by run ${group.executionHolder}. Cancel that run first.`,
					details: {
						workerId: job.id,
						resourceGroup: group.id,
						executionHolder: group.executionHolder,
					},
				},
				branch,
			);
		}
		if (group.disposing) {
			return stopped(
				{
					text: `The resources of worker ${job.id} are already being deleted.`,
					details: { workerId: job.id, resourceGroup: group.id, disposing: true },
				},
				branch,
			);
		}
	}

	// A pending actionable event blocks the cleanup. The owner handles
	// the event or discards it before the resources go.
	const pending = pendingEvents(db).filter((event) => event.runId === job.id);
	if (pending.length > 0) {
		const ids = pending.map((event) => event.id);
		return stopped(
			{
				text:
					`Worker ${job.id} has ${ids.length} unhandled event(s): ${ids.join(", ")}. ` +
					"Handle them before the cleanup.",
				details: { workerId: job.id, pendingEvents: ids },
			},
			branch,
		);
	}

	// The marker stays until the deletion finishes. A crash during the
	// deletion leaves the group disposing, and the recovery reconciles it.
	if (groupId !== null) markDisposing(db, groupId, Date.now());
	const outcome = await releaseWorktree(rt, job, force);
	const notes = [...outcome.notes];
	let removed = true;
	try {
		rmSync(job.sessionDir, { recursive: true, force: true });
		notes.push(`transcript directory removed: ${job.sessionDir}`);
	} catch (e) {
		removed = false;
		notes.push(`transcript directory NOT removed: ${String(e)}`);
	}
	// The marker stays while the deletion is unfinished. A crash during
	// the deletion leaves the group disposing for the recovery.
	if (removed && groupId !== null) clearDisposing(db, groupId, Date.now());
	rt.persist();
	return {
		refusal: null,
		notes,
		keptWorktree: outcome.kept,
		keptChanges: outcome.keptChanges,
		worktreeRemoved: job.worktreePath === null,
		worktreeGone: outcome.gone,
		branch,
	};
}
