/**
 * Watching a worker.
 *
 * The monitor polls the worker's transcript until the worker finishes, then
 * reports back. The decisions are plain functions of the job and the clock,
 * so a test can check a timeout without a real pane.
 */

import { statSync } from "node:fs";

import { readCallLedger } from "./calls.ts";
import { claudeBoundReport, claudeCompletionBlocker } from "./claude-run-state.ts";
import { type CycleState, needsIntervention, readCycleState } from "./cycle-state.ts";
import { createEvent, eventKey, resolveObsoleteEvent } from "./events.ts";
import { isActive, type Job, type JobStatus, type PendingStop } from "./job.ts";
import { completionBlockerOf, syncExecutions } from "./ledger-sync.ts";
import { finalizeJob, stopJob } from "./lifecycle.ts";
import { monitorVerdict } from "./monitor-authority.ts";
import { recordNativeEvents } from "./native-events.ts";
import { readOwnership } from "./ownership.ts";
import { taskKey } from "./owner.ts";
import { paneState } from "./pane.ts";
import { decideFromReports } from "./report-decision.ts";
import { appendReport, readReports } from "./report-store.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { listSessionFiles, type SessionSummary, summarizeSession } from "./transcript.ts";

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
	// The cycle state of each watched worker. It holds the time when the
	// cycle closed, so the settling time can be measured.
	const cycleStates = new Map<string, CycleState>();

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
		// A monitor without the authority must not end the worker.
		const verdict = monitorVerdict(readOwnership(rt.openDb(), taskKey(job.id)).owner, rt.sessionId);
		if (verdict === "stop") {
			rt.stopMonitor(job.id);
			return;
		}
		if (verdict === "wait") return;
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

		// A text-only turn does not end the worker. The report decides. The
		// report tick runs beside this one and reads the reports.
	};

	/**
	 * The tick that reads the reports of a worker.
	 *
	 * A report is the only evidence that proves a task state. The text of a
	 * turn proves nothing. A worker that reports completion finishes, and a
	 * worker that reports nothing keeps running until its deadline.
	 */
	const reportTick = () => {
		if (!isActive(job)) {
			rt.stopMonitor(job.id);
			return;
		}
		// A monitor without the authority must not end the worker.
		const verdict = monitorVerdict(readOwnership(rt.openDb(), taskKey(job.id)).owner, rt.sessionId);
		if (verdict === "stop") {
			rt.stopMonitor(job.id);
			return;
		}
		if (verdict === "wait") return;
		if (rt.stopping.has(job.id)) return;
		const now = Date.now();
		if (job.pendingStop) return stop(job.pendingStop.status, job.pendingStop.error);
		const deadline = deadlineMessage(job, now);
		if (deadline) return stop("failed", deadline);

		const file = job.sessionFile ?? listSessionFiles(job.sessionDir)[0];
		if (!file) return;
		const ledger = readCallLedger(file);
		const reports = readReports(job.sessionDir, job.id);
		const decision = decideFromReports(ledger, reports);
		const db = rt.openDb();

		// The ledger of the run holds one row for every call of this run.
		// The sync writes what the transcript shows, so the completion check
		// below sees the outstanding executions of the run.
		syncExecutions(db, job.id, ledger, job.baselineTurns, now);

		// The cycle must hold at its terminal boundary before the supervisor
		// asks the owner for help. The worker writes its report in the turn
		// that follows its answer.
		const cycle = readCycleState(ledger, cycleStates.get(job.id) ?? null, now);
		cycleStates.set(job.id, cycle);
		const settled = needsIntervention(cycle, decision.state !== "unknown", now);

		// The events keep their identity. The key joins the run, the cycle
		// and the condition, so a recovery finds the event that exists.
		const condition = settled ? decision.condition : null;
		if (condition) {
			const key = eventKey(job.id, decision.evidenceId, condition);
			createEvent(
				db,
				`ev-${job.id}-${decision.evidenceId}-${condition}`,
				key,
				job.id,
				condition,
				condition,
				null,
				true,
				now,
			);
		} else {
			// A later valid report resolves the event that the condition
			// created. The history of the event stays.
			resolveObsoleteEvent(
				db,
				job.id,
				decision.evidenceId,
				"missing_report",
				"The worker reported its task state.",
				now,
			);
		}

		// A completion report ends the worker. The outstanding execution rows
		// of the run can block it.
		if (decision.state === "completed") {
			if (completionBlockerOf(db, job.id)) return;
			end("completed", null, decision.result ?? "");
		}
	};

	rt.monitors.set(job.id, rt.startInterval(tick, rt.config.pollMs));
	rt.monitors.set(`${job.id}:reports`, rt.startInterval(reportTick, rt.config.pollMs));
}

/**
 * Watch a worker that runs a native backend.
 *
 * A native worker reports through its own bridge. The supervisor reads the
 * native state instead of the transcript. The report of the current cycle
 * ends the worker, and the outstanding work blocks it.
 */
export function monitorNativeJob(rt: WorkerRuntime, job: Job, notify: (job: Job) => void): void {
	rt.stopMonitor(job.id);

	const end = (status: JobStatus, error: string | null, result: string | null) => {
		void (async () => {
			await finalizeJob(rt, job, status, error, result);
			notify(job);
		})();
	};

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
		// A monitor without the authority must not end the worker.
		const verdict = monitorVerdict(readOwnership(rt.openDb(), taskKey(job.id)).owner, rt.sessionId);
		if (verdict === "stop") {
			rt.stopMonitor(job.id);
			return;
		}
		if (verdict === "wait") return;
		if (rt.stopping.has(job.id)) return;
		const now = Date.now();
		if (job.pendingStop) return stop(job.pendingStop.status, job.pendingStop.error);
		const deadline = deadlineMessage(job, now);
		if (deadline) return stop("failed", deadline);

		const state = rt.claudeStates.get(job.id);
		if (!state) return;

		/* A native worker writes no OMP transcript, so its activity comes
		   from the native observations. Without this the idle deadline
		   would stop a worker that is still working. */
		job.lastActivityAt = state.lastActivityAt;

		/* A permission request is a fact that the owner must know. The
		   person answers it in the pane, so the request is raised as an
		   event and it stays open until the request settles. */
		recordNativeEvents(rt.openDb(), job.id, state, now);

		const report = claudeBoundReport(state);
		if (report?.state !== "completed") return;

		/* The work that the worker still owes blocks the completion. The
		   open rows of the run block it too, because a native call that
		   never settles leaves no transcript behind. */
		const blocker = claudeCompletionBlocker(state);
		if (blocker) return;
		if (completionBlockerOf(rt.openDb(), job.id)) return;

		/* The report is the evidence of the completion. It stays beside the
		   run, so a recovery and a later reader find it. */
		persistNativeReport(job, report);
		end("completed", null, report.result ?? "");
	};

	rt.monitors.set(job.id, rt.startInterval(tick, rt.config.pollMs));
}

/**
 * Save the report of a native run beside the run.
 *
 * The report is the evidence of the completion. It lands in the same file
 * that an OMP worker writes, so a later reader finds both in one place.
 */
function persistNativeReport(
	job: Job,
	report: { cycleId: string | null; state: string; result: string | null },
): void {
	if (report.state !== "completed") return;
	try {
		appendReport(job.sessionDir, {
			runId: job.id,
			cycleId: report.cycleId,
			state: "completed",
			result: report.result,
			dependency: null,
			resumeCondition: null,
			needs: null,
			detail: null,
		});
	} catch {
		/* the completion still holds; the file is a convenience */
	}
}
