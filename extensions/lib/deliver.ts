/**
 * Delivering a finished worker back to the main session.
 *
 * The channel is set at `session_start` by the main session. Event wakes and
 * result deliveries share it, so a subagent cannot redirect either message.
 * See docs/adr/0004 for why the channel prefers `sendUserMessage`.
 */

import { backendLabel, readBackend } from "./backend.ts";
import { beginDelivery, markSent, markUncertain } from "./delivery.ts";
import { createEvent, eventKey, findEventByKey } from "./events.ts";
import type { Job } from "./job.ts";
import { nativeJobUsageReport, requestUsageOf } from "./native-usage-report.ts";
import { generationOf } from "./owner.ts";
import { turnsLabel } from "./restored-run.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { formatUsage, jobUsage, type UsageReport } from "./usage.ts";
import { writeUnderAuthority } from "./write-authority.ts";

/** The usage of the worker and of the request the worker belongs to. */
export interface DeliveryUsage {
	worker: UsageReport;
	request: UsageReport;
}
export function formatDelivery(
	job: Job,
	usage: DeliveryUsage,
	nativeCycles = 0,
	restored = false,
	eventId?: string,
): string {
	const pending = job.pendingStop;
	/* A restart cut the counts of a restored run. The delivery says that the
	   counts start at the restart. */
	const wasRestored = restored || typeof job.nativeUsage?.restoredAt === "number";
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
		job.turns > 0
			? `turns: ${job.turns}`
			: nativeCycles > 0
				? `turns: ${turnsLabel(nativeCycles, wasRestored)}`
				: null,
		`tokens: ${formatUsage(usage.worker)}`,
		job.steers > 0 ? `steers: ${job.steers}` : null,
		job.worktreePath ? `worktree: ${job.worktreePath}` : null,
		job.sessionFile ? `transcript: ${job.sessionFile}` : null,
		job.paneClosed ? "pane: closed" : null,
	]
		.filter((line): line is string => line !== null)
		.join(" | ");
	const eventLine = eventId
		? `Event id: ${eventId}. Acknowledge it with wezterm_worker_ack after you read the result.\n\n`
		: "";
	const request = `\n\nThis request so far: ${formatUsage(usage.request)}. The main session is not counted.`;
	return `${header}\n\n${body}\n\n(${meta})\n\n${eventLine}${request}`;
}

export function createDeliver(rt: WorkerRuntime): (job: Job) => void {
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
		/* A restart cut the counts of a native run. The delivery says that
		   the counts start at the restart. */
		const restored =
			readBackend(job) !== "omp" &&
			typeof (rt.claudeStates.get(job.id)?.usage.restoredAt ?? job.nativeUsage?.restoredAt) === "number";
		const db = rt.openDb();
		const attemptId = `del-${job.id}-${Date.now()}`;
		const resultKey = eventKey(job.id, "result", "result");
		/* The authority check and both writes share one transaction. */
		const delivery = writeUnderAuthority(db, rt.sessionId, job.id, () => {
			const event =
				findEventByKey(db, resultKey) ??
				createEvent(db, `ev-${job.id}-result`, resultKey, job.id, "result", "result", null, true, Date.now())
					.event;
			const text = formatDelivery(
				job,
				{
					worker: workerUsage,
					request: requestUsageOf(rt.jobs, rt.requestLaunches, rt.claudeStates),
				},
				nativeCycles,
				restored,
				job.pendingStop === null ? event.id : undefined,
			);
			const attempt = beginDelivery(db, attemptId, event.id, generationOf(rt, job.id) ?? 0, Date.now());
			return { text, attempt };
		});
		if (delivery.refused) {
			rt.errors.push(`[wezterm-worker] The delivery of worker ${job.id} was refused: ${delivery.refusal}`);
			return;
		}
		const { text } = delivery.value;
		try {
			const channel = rt.sendToMainSession(text);
			if (channel === "none") return;
			markSent(db, attemptId, channel, Date.now());
		} catch (e) {
			// The host refused the message. The event stays pending, and the
			// attempt stays uncertain.
			markUncertain(db, attemptId, e instanceof Error ? e.message : String(e), Date.now());
			throw e;
		}
	};
}
