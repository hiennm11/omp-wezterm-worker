/**
 * Delivering a finished worker back to the main session.
 *
 * The delivery must wake the main agent, not just drop text into the
 * transcript. `pi.sendUserMessage(text, { triggerTurn: true })` does that:
 * the text lands in the session as a user message and a new turn starts, so
 * the agent acts on the result immediately.
 *
 * `pi.sendMessage` with `deliverAs: "steer"` is the fallback for a host that
 * does not expose `sendUserMessage`. See docs/adr/0004.
 */

import type { ExtensionAPI } from "./host.ts";
import type { Job } from "./job.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { formatUsage, jobUsage, requestUsage, type UsageReport } from "./usage.ts";

/** The usage of the worker and of the request the worker belongs to. */
export interface DeliveryUsage {
	worker: UsageReport;
	request: UsageReport;
}

export function formatDelivery(job: Job, usage: DeliveryUsage): string {
	const pending = job.pendingStop;
	const header =
		pending !== null
			? `Async worker ${job.id} is not stopped (${job.label}).`
			: job.status === "completed"
				? `Async worker ${job.id} finished (${job.label}).`
				: `Async worker ${job.id} ${job.status} (${job.label}).`;
	const body =
		pending !== null
			? `${pending.error}. The stop is not confirmed: ${pending.failure ?? "unknown reason"}. The worker may still run. Call wezterm_worker_cancel to retry.`
			: job.status === "completed"
				? (job.result ?? "")
				: (job.error ?? job.status);
	const meta = [
		`cwd: ${job.cwd}`,
		job.model ? `model: ${job.model}` : null,
		job.paneId !== null ? `pane: ${job.paneId}` : null,
		job.turns > 0 ? `turns: ${job.turns}` : null,
		`tokens: ${formatUsage(usage.worker)}`,
		job.steers > 0 ? `steers: ${job.steers}` : null,
		job.worktreePath ? `worktree: ${job.worktreePath}` : null,
		job.sessionFile ? `transcript: ${job.sessionFile}` : null,
		job.paneClosed ? "pane: closed" : null,
	]
		.filter((line): line is string => line !== null)
		.join(" | ");
	const request = `\n\nThis request so far: ${formatUsage(usage.request)}. The main session is not counted.`;
	return `${header}\n\n${body}\n\n(${meta})${request}`;
}

export function createDeliver(pi: ExtensionAPI, rt: WorkerRuntime): (job: Job) => void {
	return (job) => {
		const text = formatDelivery(job, {
			worker: jobUsage(job),
			request: requestUsage(rt.jobs, rt.requestLaunches),
		});
		if (typeof pi.sendUserMessage === "function") {
			pi.sendUserMessage(text, { triggerTurn: true });
			return;
		}
		pi.sendMessage(text, { deliverAs: "steer", triggerTurn: true, attribution: "agent" });
	};
}
