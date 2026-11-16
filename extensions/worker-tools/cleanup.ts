/**
 * wezterm_worker_cleanup
 *
 * The only code that removes a worktree. See docs/adr/0002.
 */

import { cleanupJob } from "../lib/cleanup-action.ts";
import type { ToolCtx } from "../lib/host.ts";
import { isActive } from "../lib/job.ts";
import { subagentControlRefusal } from "../lib/subagent.ts";
import { findJob, reply, type ToolDeps } from "./kit.ts";

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
		async execute(
			_id: string,
			params: { workerId: string; force?: boolean },
			_signal: unknown,
			_onUpdate: unknown,
			ctx?: ToolCtx,
		) {
			const refusal = subagentControlRefusal(ctx);
			if (refusal) return reply(refusal, { refused: "subagent" }, true);
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
				const outcome = await cleanupJob(rt, job, params.force === true);
				if (outcome.refusal) {
					return reply(outcome.refusal.text, outcome.refusal.details, true);
				}
				return reply(`Cleanup for worker ${job.id}:\n- ${outcome.notes.join("\n- ")}`, {
					workerId: job.id,
					notes: outcome.notes,
					keptWorktree: outcome.keptWorktree,
					keptChanges: outcome.keptChanges,
					worktreeRemoved: outcome.worktreeRemoved,
				});
			});
		},
	});
}
