/**
 * wezterm_worker_prune
 *
 * The tool removes the worktree and the branch of the old workers whose work
 * is already in the target branch. See docs/adr/0031.
 */

import type { ToolCtx } from "../lib/host.ts";
import { isActive } from "../lib/job.ts";
import { DEFAULT_OLDER_THAN_DAYS, type PruneResult, pruneWorker } from "../lib/prune.ts";
import { subagentControlRefusal } from "../lib/subagent.ts";
import { reply, type ToolDeps } from "./kit.ts";

/**
 * The text of the report of the prune.
 *
 * The text names every worker and the reason of its state, so the user sees
 * what the tool did and what it left alone.
 */
function reportText(dryRun: boolean, results: PruneResult[]): string {
	const headline = dryRun ? "Prune (dry run):" : "Prune:";
	const lines = results.map((result) => {
		if (result.state === "removed") return `- ${result.workerId}: removed. ${result.reason}`;
		if (result.state === "would-remove") return `- ${result.workerId}: would remove. ${result.reason}`;
		return `- ${result.workerId}: kept. ${result.reason}`;
	});
	return `${headline}\n${lines.join("\n")}`;
}

export function registerPruneTool({ pi, rt }: ToolDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "wezterm_worker_prune",
		label: "Prune WezTerm Workers",
		description:
			"Remove the worktree and the branch of the old workers whose work is already in the " +
			"target branch. The default is a dry run, so the tool changes nothing until you pass " +
			"dryRun: false. A worker with uncommitted changes, with an untracked file, with a " +
			"stash, or with a commit that the target branch does not hold keeps its worktree and " +
			"its branch. The tool never forces.",
		parameters: z.object({
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"True changes nothing and lists the workers that a real run would remove. " +
						"The default is true.",
				),
			olderThanDays: z
				.number()
				.optional()
				.describe("A worker is old when it ended at least this many days ago. The default is 7."),
			into: z
				.string()
				.optional()
				.describe(
					"The branch that must hold the work. The default is the default branch of the " +
						"repository of the worker.",
				),
		}),
		loadMode: "essential",
		async execute(
			_id: string,
			params: { dryRun?: boolean; olderThanDays?: number; into?: string },
			_signal: unknown,
			_onUpdate: unknown,
			ctx?: ToolCtx,
		) {
			const refusal = subagentControlRefusal(ctx);
			if (refusal) return reply(refusal, { refused: "subagent" }, true);

			const dryRun = params.dryRun !== false;
			const olderThanDays = params.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS;
			const into = params.into ?? null;
			const now = Date.now();

			const results: PruneResult[] = [];
			for (const job of rt.jobs.values()) {
				if (isActive(job)) continue;
				/* A failure of one worker stops that worker only. The other
				   workers of the list go on. */
				try {
					results.push(await pruneWorker(rt, job, { into, dryRun, now, olderThanDays }));
				} catch (e) {
					results.push({
						workerId: job.id,
						state: "kept",
						reason: `the prune failed: ${e instanceof Error ? e.message : String(e)}`,
					});
				}
			}

			const removed = results.filter((result) => result.state === "removed");
			const wouldRemove = results.filter((result) => result.state === "would-remove");
			const kept = results.filter((result) => result.state === "kept");
			return reply(reportText(dryRun, results), {
				dryRun,
				removed,
				wouldRemove,
				kept,
			});
		},
	});
}
