/**
 * Watching a worker.
 *
 * The monitor polls the worker's transcript until the worker finishes, then
 * reports back. The decisions are plain functions of the job and the clock,
 * so a test can check a timeout without a real pane.
 */

import { statSync } from "node:fs";

import { isActive, type Job, type JobStatus, type PendingStop } from "./job.ts";
import { finalizeJob, stopJob } from "./lifecycle.ts";
import { paneState } from "./pane.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { isTurnComplete, listSessionFiles, type SessionSummary, summarizeSession } from "./transcript.ts";

/**
 * How long a worker may take to write its first transcript line before the
 * monitor checks whether its process is still alive.
 */
export const STARTUP_GRACE_MS = 45_000;

/**
 * The reason a worker ran out of time, or null while it is within its limits.
 *
 * The idle deadline is separate from the total deadline, so a long task that
 * keeps making progress is never killed.
 */
export function deadlineMessage(job: Job, now: number): string | null {
	const elapsed = now - (job.startedAt ?? job.createdAt);
	if (job.timeoutMs > 0 && elapsed > job.timeoutMs) {
		return `Worker timed out after ${Math.round(job.timeoutMs / 1000)}s`;
	}
	if (job.idleTimeoutMs > 0 && now - job.lastActivityAt > job.idleTimeoutMs) {
		return `Worker produced no activity for ${Math.round(job.idleTimeoutMs / 1000)}s and was stopped`;
	}
	return null;
}

/**
 * The result of a worker that finished its own turn, or null while it works.
 *
 * A resumed worker opens on a transcript that already holds a finished turn.
 * Only a turn beyond the baseline counts as this worker's own result,
 * otherwise the previous answer is delivered as the new one.
 */
export function finishedResult(job: Job, summary: SessionSummary): string | null {
	if (!isTurnComplete(summary)) return null;
	if (summary.finalTextIndex <= job.baselineTurns) return null;
	return summary.finalText ?? "";
}

/**
 * Read the newest transcript into the job and note any activity.
 *
 * A new transcript file, or a change in its size, means the worker did
 * something. Returns null while the worker has written no transcript yet.
 */
export function observeTranscript(job: Job, now: number): SessionSummary | null {
	const files = listSessionFiles(job.sessionDir);
	if (files.length === 0) return null;
	const file = files[0];
	const previousFile = job.sessionFile;
	job.sessionFile = file;
	const summary = summarizeSession(file);
	job.currentTool = summary.currentTool;
	job.turns = summary.turns;
	if (previousFile !== file) {
		job.lastActivityAt = now;
		return summary;
	}
	try {
		const size = statSync(file).size;
		if (size !== job.lastTranscriptSize) {
			job.lastActivityAt = now;
			job.lastTranscriptSize = size;
		}
	} catch {
		// The transcript vanished mid-read; the next poll handles it.
	}
	return summary;
}

/**
 * Poll the worker session file until its turn completes, then report back.
 * `notify` delivers the result into the main session.
 *
 * A worker that dies during startup (missing omp binary, bad --model, a crash
 * before the session file is written) never produces a session file. The pane
 * disappears in that case, so the monitor treats "pane gone and still no
 * session file" as a startup failure instead of waiting for the timeout.
 */
export function monitorJob(rt: WorkerRuntime, job: Job, notify: (job: Job) => void): void {
	rt.stopMonitor(job.id);

	const end = (status: JobStatus, error: string | null, result: string | null) => {
		void (async () => {
			await finalizeJob(rt, job, status, error, result);
			notify(job);
		})();
	};

	// Notify on a confirmed stop and on the first unconfirmed attempt. A
	// failure that is already reported is not delivered again.
	const stop = (status: PendingStop["status"], error: string) => {
		void (async () => {
			const hadFailure = job.pendingStop?.failure != null;
			const outcome = await stopJob(rt, job, status, error);
			if (outcome.stopped || !hadFailure) notify(job);
		})();
	};

	const tick = () => {
		if (!isActive(job)) {
			rt.stopMonitor(job.id);
			return;
		}
		// A poll must not overlap a stop that is still waiting for confirmation.
		if (rt.stopping.has(job.id)) return;
		const now = Date.now();
		// A pending stop wins over a fresh deadline and over the transcript.
		if (job.pendingStop) return stop(job.pendingStop.status, job.pendingStop.error);
		const deadline = deadlineMessage(job, now);
		if (deadline) return stop("failed", deadline);

		const summary = observeTranscript(job, now);
		if (summary === null) {
			// No transcript yet. If the pane is gone the worker process exited
			// during startup; wait out the grace period before declaring it.
			const paneId = job.paneId;
			if (now - (job.startedAt ?? job.createdAt) < STARTUP_GRACE_MS || paneId === null) return;
			void (async () => {
				if ((await paneState(rt, paneId)) !== "gone") return;
				if (listSessionFiles(job.sessionDir).length > 0) return;
				await finalizeJob(
					rt,
					job,
					"failed",
					"Worker process exited before producing a transcript (check the pane for the startup error)",
					null,
				);
				notify(job);
			})();
			return;
		}

		const finalText = finishedResult(job, summary);
		if (finalText === null) return;
		end("completed", null, finalText);
	};

	rt.monitors.set(job.id, rt.startInterval(tick, rt.config.pollMs));
}
