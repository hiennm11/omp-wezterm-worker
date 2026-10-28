/**
 * wezterm_worker_cleanup
 *
 * The only code that removes a worktree. See docs/adr/0002.
 */

import { rmSync } from "node:fs";

import { cleanupRefusal, refusalDetails } from "../lib/authority.ts";
import { pendingEvents } from "../lib/events.ts";
import { freeEndedHolder } from "../lib/group-holder.ts";
import { clearDisposing, groupOfRun, markDisposing } from "../lib/groups.ts";
import { activeSharers, isActive, type Job } from "../lib/job.ts";
import { taskKey } from "../lib/owner.ts";
import { readOwnership } from "../lib/ownership.ts";
import { paneState } from "../lib/pane.ts";
import type { WorkerRuntime } from "../lib/runtime.ts";
import { stopIntentRefusal } from "../lib/stop-reconcile.ts";
import { inspectWorktree, removeWorktree } from "../lib/worktree.ts";
import { findJob, reply, type ToolDeps } from "./kit.ts";

interface WorktreeOutcome {
	notes: string[];
	kept: string | null;
	keptChanges: string[];
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
	if (!path) return { notes: [], kept: null, keptChanges: [] };

	const pane = job.paneId === null ? "gone" : await paneState(rt, job.paneId);
	if (pane === "present") {
		return {
			notes: [`worktree kept: close pane ${job.paneId} first, it holds the directory`],
			kept: path,
			keptChanges: [],
		};
	}
	if (pane === "unknown") {
		return {
			notes: [
				`worktree kept: the WezTerm pane list cannot be read, so pane ${job.paneId} may still hold the directory`,
			],
			kept: path,
			keptChanges: [],
		};
	}

	const state = await inspectWorktree(rt, path);
	if (!state.exists) {
		return { notes: [`worktree already gone: ${path}`], kept: null, keptChanges: [] };
	}
	if (!state.clean && !force) {
		return {
			notes: [
				`worktree kept: it has uncommitted changes (${state.changes.length}). Keep it, or pass force to discard them.`,
				...state.changes.map((change) => `  ${change}`),
			],
			kept: path,
			keptChanges: state.changes,
		};
	}

	const removal = await removeWorktree(rt, job.worktreeOrigin ?? job.cwd, path);
	if (!removal.removed) {
		return {
			notes: [`worktree NOT removed (${removal.error ?? "unknown"}): ${path}`],
			kept: path,
			keptChanges: [],
		};
	}
	const notes = [`worktree removed: ${path}`];
	if (job.worktreeBranch) {
		notes.push(`branch kept (commits made by the worker survive): ${job.worktreeBranch}`);
	}
	job.worktreePath = null;
	job.worktreeBranch = null;
	return { notes, kept: null, keptChanges: [] };
}

export function registerCleanupTool({ pi, rt }: ToolDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "wezterm_worker_cleanup",
		label: "Clean Up WezTerm Worker",
		description:
			"Release the resources of a finished worker: remove its isolated git worktree and " +
			"delete its transcript directory. A worktree with uncommitted changes is kept " +
			"unless force is set, so the work of the worker is never thrown away. " +
			"Does not touch other workers or user panes.",
		parameters: z.object({
			workerId: z.string().describe("Id of the worker to clean up."),
			force: z
				.boolean()
				.optional()
				.describe(
					"Remove the worktree even when it holds uncommitted changes or untracked files. " +
						"Without this the worktree is kept and the changes are reported.",
				),
		}),
		loadMode: "essential",
		async execute(_id: string, params: { workerId: string; force?: boolean }) {
			const found = findJob(rt, params.workerId);
			if ("error" in found) return found.error;
			const { job } = found;
			if (isActive(job)) {
				return reply(
					`Worker ${job.id} is still ${job.status}. Cancel it first.`,
					{ workerId: job.id, status: job.status },
					true,
				);
			}
			/* The gate holds the action while the release waits for it. The
			   authority is checked before the deletion, so a session that
			   lost the task never removes the resources of the owner. */
			return rt.runAction(`cleanup:${job.id}`, async () => {
				const owner = readOwnership(rt.openDb(), taskKey(job.id)).owner;
				const refusal = cleanupRefusal(owner, rt.sessionId, job.id);
				if (refusal) return reply(refusal, refusalDetails(job.id, owner), true);
				// A pending stop intent means that a destructive command may have
				// run. The cleanup must not act on a worker whose pane may
				// already be closed.
				const intentRefusal = stopIntentRefusal(rt.openDb(), job.id);
				if (intentRefusal) {
					return reply(intentRefusal, { workerId: job.id, stopIntent: "pending" }, true);
				}
				const sharers = activeSharers(rt.jobs.values(), job);
				if (sharers.length > 0) {
					const ids = sharers.map((other) => other.id);
					return reply(
						`Worker ${job.id} shares its transcript and worktree with active worker ${ids.join(", ")}. ` +
							"Cancel that worker first.",
						{ workerId: job.id, activeSharers: ids },
						true,
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
						return reply(
							`The state of the resources of worker ${job.id} is unknown. Resolve the worker first.`,
							{ workerId: job.id, resourceGroup: group.id, executionState: group.executionState },
							true,
						);
					}
					// A holder that ended keeps the group until its pane is gone.
					// The cleanup frees the group when the pane of the holder is
					// gone.
					const holderRefusal = await freeEndedHolder(rt, group);
					if (holderRefusal) {
						const holder = group.executionHolder === null ? undefined : rt.jobs.get(group.executionHolder);
						return reply(
							holderRefusal,
							{
								workerId: job.id,
								resourceGroup: group.id,
								executionHolder: group.executionHolder,
								pane: holder?.paneId ?? null,
							},
							true,
						);
					}
					group = groupOfRun(db, job) ?? group;
					if (group.executionHolder !== null && group.executionHolder !== job.id) {
						return reply(
							`The resources of worker ${job.id} are used by run ${group.executionHolder}. Cancel that run first.`,
							{ workerId: job.id, resourceGroup: group.id, executionHolder: group.executionHolder },
							true,
						);
					}
					if (group.disposing) {
						return reply(
							`The resources of worker ${job.id} are already being deleted.`,
							{ workerId: job.id, resourceGroup: group.id, disposing: true },
							true,
						);
					}
				}

				// A pending actionable event blocks the cleanup. The owner handles
				// the event or discards it before the resources go.
				const pending = pendingEvents(db).filter((event) => event.runId === job.id);
				if (pending.length > 0) {
					const ids = pending.map((event) => event.id);
					return reply(
						`Worker ${job.id} has ${ids.length} unhandled event(s): ${ids.join(", ")}. ` +
							"Handle them before the cleanup.",
						{ workerId: job.id, pendingEvents: ids },
						true,
					);
				}

				// The marker stays until the deletion finishes. A crash during the
				// deletion leaves the group disposing, and the recovery reconciles it.
				if (groupId !== null) markDisposing(db, groupId, Date.now());
				const outcome = await releaseWorktree(rt, job, params.force === true);
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
				return reply(`Cleanup for worker ${job.id}:\n- ${notes.join("\n- ")}`, {
					workerId: job.id,
					notes,
					keptWorktree: outcome.kept,
					keptChanges: outcome.keptChanges,
					worktreeRemoved: job.worktreePath === null,
				});
			});
		},
	});
}
