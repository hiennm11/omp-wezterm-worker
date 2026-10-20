/**
 * wezterm_worker_resume
 */

import type { ToolCtx } from "../lib/host.ts";
import { isActive } from "../lib/job.ts";
import { admitLaunch } from "../lib/limits.ts";
import { monitorJob } from "../lib/monitor.ts";
import { resumeWorker } from "../lib/spawn.ts";
import { findJob, refusalReply, reply, type ToolDeps } from "./kit.ts";

export function registerResumeTool({ pi, rt, deliver }: ToolDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "wezterm_worker_resume",
		label: "Resume WezTerm Worker",
		description:
			"Reopen a finished worker in a new WezTerm pane, continuing its transcript. " +
			"The worker comes back with its full history, so it can be given a follow-up instruction. " +
			"Use this to continue work that a completed worker started.",
		parameters: z.object({
			workerId: z.string().describe("Id of the worker to resume."),
			message: z
				.string()
				.optional()
				.describe("Follow-up instruction for the worker. Omit to reopen it without a new instruction."),
			placement: z.string().optional().describe("'split' (default) or 'tab'."),
		}),
		loadMode: "essential",
		async execute(
			_id: string,
			params: { workerId: string; message?: string; placement?: string },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ToolCtx,
		) {
			const found = findJob(rt, params.workerId);
			if ("error" in found) return found.error;
			const { job } = found;
			if (isActive(job)) {
				return reply(
					`Worker ${job.id} is still ${job.status}. Steer it instead of resuming it.`,
					{ workerId: job.id, status: job.status },
					true,
				);
			}
			const admitted = admitLaunch(rt, ctx.sessionManager?.getSessionFile?.());
			if ("refusal" in admitted) return refusalReply(admitted.refusal);
			const resumed = await resumeWorker(rt, job, {
				jobId: admitted.jobId,
				message: params.message,
				placement: params.placement === "tab" ? "tab" : "split",
			});
			if (resumed.status === "failed") {
				return reply(
					`Could not resume worker: ${resumed.error ?? "unknown error"}`,
					{ workerId: resumed.id, status: resumed.status, error: resumed.error },
					true,
				);
			}
			monitorJob(rt, resumed, deliver);
			const transcript = resumed.sessionFile ?? resumed.sessionDir;
			return reply(
				`Worker ${job.id} resumed as ${resumed.id} in pane ${resumed.paneId}.\n` +
					`transcript: ${transcript}\n\n` +
					"It continues from its transcript. Its next result is delivered back automatically.",
				{
					workerId: resumed.id,
					resumedFrom: job.id,
					paneId: resumed.paneId,
					status: resumed.status,
					transcript,
				},
			);
		},
	});
}
