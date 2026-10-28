/**
 * wezterm_worker_resume
 */

import { cleanupRefusal, refusalDetails } from "../lib/authority.ts";
import { readBackend } from "../lib/backend.ts";
import type { ToolCtx } from "../lib/host.ts";
import { isActive } from "../lib/job.ts";
import { admitLaunch } from "../lib/limits.ts";
import { monitorJob, monitorNativeJob } from "../lib/monitor.ts";
import { acquireTask, bindSession, maySupervise, taskKey } from "../lib/owner.ts";
import { readOwnership } from "../lib/ownership.ts";
import { resumeClaudeWorker } from "../lib/resume-claude.ts";
import { resumeWorker } from "../lib/spawn.ts";
import { stopIntentRefusal } from "../lib/stop-reconcile.ts";
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
			/* The gate holds the action while the release waits for it. The
			   authority of the source run is checked before the launch, so a
			   refused resume counts no launch. */
			return rt.runAction(`resume:${job.id}`, async () => {
				const owner = readOwnership(rt.openDb(), taskKey(job.id)).owner;
				const refusal = cleanupRefusal(owner, rt.sessionId, job.id);
				if (refusal) return reply(refusal, refusalDetails(job.id, owner), true);
				// A pending stop intent means that a destructive command may have
				// run. The resume must not start a second writer on a worker
				// whose pane may already be closed.
				const intentRefusal = stopIntentRefusal(rt.openDb(), job.id);
				if (intentRefusal) {
					return reply(intentRefusal, { workerId: job.id, stopIntent: "pending" }, true);
				}
				const admitted = admitLaunch(rt, ctx.sessionManager?.getSessionFile?.());
				if ("refusal" in admitted) return refusalReply(admitted.refusal);
				bindSession(rt, ctx.sessionManager);
				const acquisition = await acquireTask(rt, admitted.jobId);
				if (!maySupervise(acquisition)) {
					return reply(
						`The task of worker ${admitted.jobId} cannot be acquired: ${acquisition.acquired ? "" : acquisition.reason}`,
						{ acquired: false },
						true,
					);
				}
				/* A native worker resumes in the same native session. A run
				   without a native session id cannot be resumed, because the
				   extension never starts a different session behind the owner's
				   back. */
				const backend = readBackend(job);
				const sessionId = job.nativeSessionId ?? null;
				if (backend !== "omp" && !sessionId) {
					return reply(
						`Worker ${job.id} has no native session id. It cannot be resumed.`,
						{ workerId: job.id, backend },
						true,
					);
				}
				const resumed =
					backend === "omp"
						? await resumeWorker(rt, job, {
								jobId: admitted.jobId,
								message: params.message,
								placement: params.placement === "tab" ? "tab" : "split",
							})
						: await resumeClaudeWorker(rt, {
								jobId: admitted.jobId,
								source: job,
								sessionId: sessionId as string,
								message: params.message,
							});
				if (resumed.status === "failed") {
					return reply(
						`Could not resume worker: ${resumed.error ?? "unknown error"}`,
						{ workerId: resumed.id, status: resumed.status, error: resumed.error },
						true,
					);
				}
				/* A native worker reports through its own bridge. */
				if (readBackend(resumed) === "omp") monitorJob(rt, resumed, deliver);
				else monitorNativeJob(rt, resumed, deliver);
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
			});
		},
	});
}
