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

import { backendLabel, readBackend } from "./backend.ts";
import { beginDelivery, markSent, markUncertain } from "./delivery.ts";
import type { ExtensionAPI } from "./host.ts";
import type { Job } from "./job.ts";
import { nativeJobUsageReport, requestUsageOf } from "./native-usage-report.ts";
import { generationOf } from "./owner.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { formatUsage, jobUsage, type UsageReport } from "./usage.ts";
import { writeUnderAuthority } from "./write-authority.ts";

/** The usage of the worker and of the request the worker belongs to. */
export interface DeliveryUsage {
	worker: UsageReport;
	request: UsageReport;
}

export function formatDelivery(job: Job, usage: DeliveryUsage, nativeCycles = 0): string {
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
		`backend: ${backendLabel(readBackend(job))}`,
		job.model ? `model: ${job.model}` : null,
		job.paneId !== null ? `pane: ${job.paneId}` : null,
		job.turns > 0 ? `turns: ${job.turns}` : nativeCycles > 0 ? `turns: ${nativeCycles}` : null,
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
		/* A native worker reports its usage through its bridge. The OMP
		   reader finds no transcript, so the native totals are the measured
		   ones. */
		const workerUsage =
			readBackend(job) === "omp"
				? jobUsage(job)
				: nativeJobUsageReport(job, rt.claudeStates.get(job.id) ?? null);
		/* A native worker counts its cycles in its own state. The job holds
		   the count of a finished run. */
		const nativeCycles =
			readBackend(job) === "omp" ? 0 : (rt.claudeStates.get(job.id)?.cycles.length ?? job.nativeCycles ?? 0);
		const text = formatDelivery(
			job,
			{
				worker: workerUsage,
				request: requestUsageOf(rt.jobs, rt.requestLaunches, rt.claudeStates),
			},
			nativeCycles,
		);
		// The delivery attempt is recorded before the message goes out. The
		// attempt keeps the event identity and the owner generation. A
		// settled attempt and an uncertain attempt stay distinct from a
		// handling acknowledgement.
		const db = rt.openDb();
		const attemptId = `del-${job.id}-${Date.now()}`;
		/* Only the owner of the task may deliver the result. The check and
		   the attempt run in one transaction, so a session that lost the
		   task sends no message and writes no attempt. */
		const attempt = writeUnderAuthority(db, rt.sessionId, job.id, () =>
			beginDelivery(db, attemptId, job.id, generationOf(rt, job.id) ?? 0, Date.now()),
		);
		if (attempt.refused) {
			// The event stays pending for the owner that holds the task.
			pi.logger?.warn?.(`[wezterm-worker] The delivery of worker ${job.id} was refused: ${attempt.refusal}`);
			return;
		}
		try {
			if (typeof pi.sendUserMessage === "function") {
				pi.sendUserMessage(text, { triggerTurn: true });
				markSent(db, attemptId, "sendUserMessage", Date.now());
				return;
			}
			pi.sendMessage(text, { deliverAs: "steer", triggerTurn: true, attribution: "agent" });
			markSent(db, attemptId, "sendMessage", Date.now());
		} catch (e) {
			// The host refused the message. The event stays pending, and the
			// attempt stays uncertain.
			markUncertain(db, attemptId, e instanceof Error ? e.message : String(e), Date.now());
			throw e;
		}
	};
}
