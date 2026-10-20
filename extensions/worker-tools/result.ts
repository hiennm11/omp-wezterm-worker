/**
 * wezterm_worker_result
 */

import { isActive } from "../lib/job.ts";
import { findJob, reply, type ToolDeps } from "./kit.ts";

export function registerResultTool({ pi, rt }: ToolDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "wezterm_worker_result",
		label: "WezTerm Worker Result",
		description: "Read a finished worker's output. Returns the final assistant text of the worker session.",
		parameters: z.object({
			workerId: z.string().describe("Id of the worker to read."),
		}),
		loadMode: "essential",
		async execute(_id: string, params: { workerId: string }) {
			const found = findJob(rt, params.workerId);
			if ("error" in found) return found.error;
			const { job } = found;
			if (job.result === null && isActive(job)) {
				return reply(`Worker ${job.id} is still ${job.status}.`, { workerId: job.id, status: job.status });
			}
			return reply(job.result ?? job.error ?? "(no output)", {
				workerId: job.id,
				status: job.status,
				result: job.result,
				error: job.error,
				cwd: job.cwd,
				transcript: job.sessionFile ?? job.sessionDir,
			});
		},
	});
}
