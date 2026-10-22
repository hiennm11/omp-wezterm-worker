/**
 * wezterm_worker_steer
 */

import { readBackend } from "../lib/backend.ts";
import { checkComms } from "../lib/comms-check.ts";
import { isActive } from "../lib/job.ts";
import { paneState } from "../lib/pane.ts";
import { steerWorker } from "../lib/steer.ts";
import { steerNative } from "../lib/steer-native.ts";
import { commsDetails, commsRefusalLine, commsWarningLine, findJob, reply, type ToolDeps } from "./kit.ts";

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
			/* The communication check runs before the instruction reaches the
			   worker. The enforce mode refuses a message that scores below
			   the minimum score. */
			const comms = checkComms(params.message, "steer", rt.config.commsStandard);
			if (comms.verdict === "fail") {
				return reply(
					commsRefusalLine(comms, rt.config.commsStandard),
					{ ...commsDetails(comms), refused: "commsStandard" },
					true,
				);
			}
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
			if ((await paneState(rt, paneId)) === "gone") {
				return reply(
					`The pane of worker ${job.id} is gone. The worker process exited.`,
					{ workerId: job.id, status: job.status, paneId },
					true,
				);
			}
			/* A native worker takes the instruction through its bridge. The
			   native prompt API queues it, so a running tool is not
			   interrupted. */
			if (readBackend(job) !== "omp") {
				const bridge = rt.bridges.get(job.id);
				const state = rt.claudeStates.get(job.id);
				if (!bridge || !state) {
					return reply(
						`Worker ${job.id} has no native bridge. Its process may have exited.`,
						{ workerId: job.id, status: job.status, paneId },
						true,
					);
				}
				const outcome = await steerNative(bridge, state, params.message);
				if (!outcome.ok) {
					return reply(
						`Could not send to worker ${job.id}: ${outcome.error ?? "unknown error"}`,
						{
							workerId: job.id,
							status: job.status,
							paneId,
							error: outcome.error,
							phase: outcome.phase,
						},
						true,
					);
				}
				job.steers += 1;
				job.lastActivityAt = Date.now();
				rt.persist();
				const queued = [
					`Queued for worker ${job.id} in pane ${paneId}:\n${params.message}\n\n` +
						"The worker continues working; its final result is still delivered back automatically.",
				];
				if (comms.verdict === "warn") queued.push(commsWarningLine(comms, rt.config.commsStandard));
				return reply(queued.join("\n"), {
					workerId: job.id,
					status: job.status,
					paneId,
					steers: job.steers,
					phase: outcome.phase,
					...commsDetails(comms),
				});
			}
			const steered = await steerWorker(rt, job, paneId, params.message);
			if (!steered.ok) {
				return reply(
					`Could not confirm the instruction to worker ${job.id}: ${steered.error ?? "unknown error"}`,
					{
						workerId: job.id,
						status: job.status,
						paneId,
						error: steered.error,
						attempts: steered.attempts,
						delivered: false,
					},
					true,
				);
			}
			job.steers += 1;
			job.lastActivityAt = Date.now();
			const sent = [
				`Sent to worker ${job.id} in pane ${paneId}:\n${params.message}\n\n` +
					"The worker continues working; its final result is still delivered back automatically.",
			];
			if (comms.verdict === "warn") sent.push(commsWarningLine(comms, rt.config.commsStandard));
			return reply(sent.join("\n"), {
				workerId: job.id,
				status: job.status,
				paneId,
				steers: job.steers,
				attempts: steered.attempts,
				delivered: true,
				...commsDetails(comms),
			});
		},
	});
}
