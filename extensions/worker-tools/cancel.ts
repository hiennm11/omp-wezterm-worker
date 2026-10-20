/**
 * wezterm_worker_cancel
 */

import { isActive } from "../lib/job.ts";
import { cancelJob } from "../lib/lifecycle.ts";
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
			const cancelled = await cancelJob(rt, job);
			if (cancelled.error) {
				return reply(
					`Worker ${job.id} was cancelled, but its pane did not close: ${cancelled.error}`,
					{
						workerId: job.id,
						status: job.status,
						paneId: job.paneId,
						paneClosed: cancelled.paneClosed,
						error: cancelled.error,
					},
					true,
				);
			}
			return reply(`Worker ${job.id} cancelled. Pane ${job.paneId} closed.`, {
				workerId: job.id,
				status: job.status,
				paneId: job.paneId,
				paneClosed: true,
			});
		},
	});
}
