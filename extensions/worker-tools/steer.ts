/**
 * wezterm_worker_steer
 */

import { isActive } from "../lib/job.ts";
import { paneExists } from "../lib/pane.ts";
import { steerWorker } from "../lib/steer.ts";
import { findJob, reply, type ToolDeps } from "./kit.ts";

export function registerSteerTool({ pi, rt }: ToolDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "wezterm_worker_steer",
		label: "Steer WezTerm Worker",
		description:
			"Send a new instruction into a running worker, exactly as if the user typed it into the worker's pane. " +
			"The worker receives it as a follow-up user message and continues working. " +
			"Use this to redirect a long-running worker without cancelling it.",
		parameters: z.object({
			workerId: z.string().describe("Id of the running worker to steer."),
			message: z.string().describe("The instruction to send into the worker."),
		}),
		loadMode: "essential",
		async execute(_id: string, params: { workerId: string; message: string }) {
			const found = findJob(rt, params.workerId);
			if ("error" in found) return found.error;
			const { job } = found;
			if (!isActive(job)) {
				return reply(
					`Worker ${job.id} is already ${job.status} and cannot be steered.`,
					{ workerId: job.id, status: job.status },
					true,
				);
			}
			if (job.paneId === null) {
				return reply(`Worker ${job.id} has no pane yet.`, { workerId: job.id, status: job.status }, true);
			}
			const paneId = job.paneId;
			if (!(await paneExists(rt, paneId))) {
				return reply(
					`The pane of worker ${job.id} is gone. The worker process exited.`,
					{ workerId: job.id, status: job.status, paneId },
					true,
				);
			}
			const steered = await steerWorker(rt, job, paneId, params.message);
			if (!steered.ok) {
				return reply(
					`Could not send to worker ${job.id}: ${steered.error ?? "unknown error"}`,
					{
						workerId: job.id,
						status: job.status,
						paneId,
						error: steered.error,
						attempts: steered.attempts,
					},
					true,
				);
			}
			job.steers += 1;
			job.lastActivityAt = Date.now();
			return reply(
				`Sent to worker ${job.id} in pane ${paneId}:\n${params.message}\n\n` +
					"The worker continues working; its final result is still delivered back automatically.",
				{
					workerId: job.id,
					status: job.status,
					paneId,
					steers: job.steers,
					attempts: steered.attempts,
				},
			);
		},
	});
}
