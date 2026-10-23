/**
 * wezterm_worker_cancel
 */

import { controlRefusal, refusalDetails } from "../lib/authority.ts";
import { isActive } from "../lib/job.ts";
import { cancelJob } from "../lib/lifecycle.ts";
import { taskKey } from "../lib/owner.ts";
import { readOwnership } from "../lib/ownership.ts";
import { findJob, reply, type ToolDeps } from "./kit.ts";

export function registerCancelTool({ pi, rt }: ToolDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "wezterm_worker_cancel",
		label: "Cancel WezTerm Worker",
		description:
			"Cancel a running worker and close only the pane that worker created. " +
			"Never touches other panes or processes.",
		parameters: z.object({
			workerId: z.string().describe("Id of the worker to cancel."),
		}),
		loadMode: "essential",
		async execute(_id: string, params: { workerId: string }) {
			const found = findJob(rt, params.workerId);
			if ("error" in found) return found.error;
			const { job } = found;
			if (!isActive(job)) {
				return reply(`Worker ${job.id} is already ${job.status}.`, { workerId: job.id, status: job.status });
			}
			/* The gate holds the action while the release waits for it. The
			   authority is checked before the action, so a session that lost
			   the task never touches the pane. */
			return rt.runAction(`cancel:${job.id}`, async () => {
				const owner = readOwnership(rt.openDb(), taskKey(job.id)).owner;
				const refusal = controlRefusal(owner, rt.sessionId, job.id);
				if (refusal) return reply(refusal, refusalDetails(job.id, owner), true);
				const outcome = await cancelJob(rt, job);
				if (!outcome.stopped) {
					return reply(
						`Worker ${job.id} is not stopped: ${outcome.error}. It still counts as running. Call wezterm_worker_cancel again to retry.`,
						{
							workerId: job.id,
							status: job.status,
							paneId: job.paneId,
							stopped: false,
							error: outcome.error,
						},
						true,
					);
				}
				return reply(`Worker ${job.id} cancelled. Pane ${job.paneId} is confirmed closed.`, {
					workerId: job.id,
					status: job.status,
					paneId: job.paneId,
					stopped: true,
				});
			});
		},
	});
}
