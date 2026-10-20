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

export function formatDelivery(job: Job): string {
	const header =
		job.status === "completed"
			? `Async worker ${job.id} finished (${job.label}).`
			: `Async worker ${job.id} ${job.status} (${job.label}).`;
	const body = job.status === "completed" ? (job.result ?? "") : (job.error ?? job.status);
	const meta = [
		`cwd: ${job.cwd}`,
		job.model ? `model: ${job.model}` : null,
		job.paneId !== null ? `pane: ${job.paneId}` : null,
		job.turns > 0 ? `turns: ${job.turns}` : null,
		job.steers > 0 ? `steers: ${job.steers}` : null,
		job.worktreePath ? `worktree: ${job.worktreePath}` : null,
		job.sessionFile ? `transcript: ${job.sessionFile}` : null,
		job.paneClosed ? "pane: closed" : null,
	]
		.filter((line): line is string => line !== null)
		.join(" | ");
	return `${header}\n\n${body}\n\n(${meta})`;
}

export function createDeliver(pi: ExtensionAPI): (job: Job) => void {
	return (job) => {
		const text = formatDelivery(job);
		if (typeof pi.sendUserMessage === "function") {
			pi.sendUserMessage(text, { triggerTurn: true });
			return;
		}
		pi.sendMessage(text, { deliverAs: "steer", triggerTurn: true, attribution: "agent" });
	};
}
