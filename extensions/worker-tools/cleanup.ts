/**
 * wezterm_worker_cleanup
 *
 * The only code that removes a worktree. See docs/adr/0002.
 */

import { rmSync } from "node:fs";

import { pendingEvents } from "../lib/events.ts";
import { clearDisposing, markDisposing, readGroup } from "../lib/groups.ts";
import { activeSharers, isActive, type Job } from "../lib/job.ts";
import { paneState } from "../lib/pane.ts";
import type { WorkerRuntime } from "../lib/runtime.ts";
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
			const groupId = `grp-${job.id}`;
			const group = readGroup(db, groupId);
			if (group) {
				if (group.executionState === "unknown") {
					return reply(
						`The state of the resources of worker ${job.id} is unknown. Resolve the worker first.`,
						{ workerId: job.id, resourceGroup: groupId, executionState: group.executionState },
						true,
					);
				}
				if (group.executionHolder !== null && group.executionHolder !== job.id) {
					return reply(
						`The resources of worker ${job.id} are used by run ${group.executionHolder}. Cancel that run first.`,
						{ workerId: job.id, resourceGroup: groupId, executionHolder: group.executionHolder },
						true,
					);
				}
				if (group.disposing) {
					return reply(
						`The resources of worker ${job.id} are already being deleted.`,
						{ workerId: job.id, resourceGroup: groupId, disposing: true },
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
			markDisposing(db, groupId, Date.now());
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
			if (removed) clearDisposing(db, groupId, Date.now());
			rt.persist();
			return reply(`Cleanup for worker ${job.id}:\n- ${notes.join("\n- ")}`, {
				workerId: job.id,
				notes,
				keptWorktree: outcome.kept,
				keptChanges: outcome.keptChanges,
				worktreeRemoved: job.worktreePath === null,
			});
		},
	});
}
