/**
 * Resuming a Claude Code worker.
 *
 * A Claude worker resumes in the same native session. The session keeps its
 * history, so the worker comes back with the task and the answers that it
 * already produced.
 *
 * A backend change needs a new worker and a new task. The function never
 * starts a Claude session for an OMP run.
 */

import { mkdirSync } from "node:fs";

import { attachAttempt, markIssued, markUnused, reserveAttempt } from "./attempts.ts";
import { handoverFile, writeHandover } from "./bridge-handover.ts";
import { startBridge } from "./claude-bridge.ts";
import { applyObservation, createClaudeRunState } from "./claude-run-state.ts";
import {
	checkClaude,
	claudeResumeArgv,
	pluginOf,
	preparePlugin,
	typeFollowUp,
	waitForComposer,
} from "./claude-session.ts";
import { releaseExecutionByHolder, reserveExecution } from "./groups.ts";
import { freshRunState, type Job } from "./job.ts";
import { launchProgram } from "./pane.ts";
import { delay } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { writeRunContext } from "./worker-context.ts";

/** How long the resume waits for the native process of the source run. */
const NATIVE_EXIT_TIMEOUT_MS = 30_000;

/** The wait between two checks of the native process. */
const PROCESS_POLL_MS = 500;

/** The parameters of a Claude resume. */
export interface ClaudeResumeParams {
	/** Id reserved by `admitLaunch`. */
	jobId: string;
	/** The run that this run resumes. */
	source: Job;
	/** The native session id of the source run. */
	sessionId: string;
	/** The follow-up instruction, when the owner gave one. */
	message?: string;
}

/**
 * Resume a Claude Code worker.
 *
 * The function returns the job of the new run. A resume that fails leaves
 * the job failed with the reason.
 */
export async function resumeClaudeWorker(rt: WorkerRuntime, params: ClaudeResumeParams): Promise<Job> {
	const { source } = params;
	const { jobId } = params;
	const job: Job = {
		...source,
		id: jobId,
		label: `${source.label} (resumed)`,
		...freshRunState(Date.now()),
	};

	const db = rt.openDb();
	const groupId = `grp-${source.id}`;
	const reservation = reserveExecution(db, groupId, jobId, Date.now());
	if (!reservation.granted) {
		const failed: Job = { ...job, status: "failed", error: reservation.reason, finishedAt: Date.now() };
		rt.jobs.set(jobId, failed);
		return failed;
	}

	/* The run context names the new run and keeps the group of the source.
	   The report of the source run cannot finish the new run. */
	writeRunContext(job.sessionDir, {
		runId: jobId,
		sourceRunId: source.id,
		resourceGroup: groupId,
	});
	rt.jobs.set(jobId, job);

	const missing = await checkClaude(rt, rt.config.claudeBin);
	if (missing) {
		job.status = "failed";
		job.error = missing;
		job.finishedAt = Date.now();
		// The run never reached a pane, so it holds nothing. The group of the
		// source run becomes free again.
		releaseExecutionByHolder(db, jobId, Date.now());
		return job;
	}

	/* A native session keeps its id while it runs. The CLI refuses a resume
	   that starts before the old process ended, so the resume waits for the
	   process of the source run to go. */
	if (params.sessionId) {
		const ended = await waitNativeExit(rt, params.sessionId, NATIVE_EXIT_TIMEOUT_MS);
		if (!ended) {
			job.status = "failed";
			job.error = `The native session of worker ${source.id} is still running. It must end before the resume.`;
			job.finishedAt = Date.now();
			releaseExecutionByHolder(db, jobId, Date.now());
			return job;
		}
	}

	mkdirSync(job.sessionDir, { recursive: true });
	/* The resumed session reuses the plugin of its source run. A native
	   session keeps its history, and the history names the plugin that it
	   loaded. A new plugin directory would break that link. */
	const sourcePlugin = pluginOf(source.sessionDir);
	const pluginDir = sourcePlugin ?? preparePlugin(job.sessionDir);

	/* The new run gets a new bridge. The native session keeps its history,
	   but the run identity of the new run is new. */
	const state = createClaudeRunState(jobId);
	rt.claudeStates.set(jobId, state);
	const bridge = await startBridge(jobId, (observation) => {
		applyObservation(state, observation);
	});
	rt.bridges.set(jobId, bridge);
	/* The worker finds its bridge through the handover file, so a new owner
	   can take over a worker that keeps running. */
	writeHandover(job.sessionDir, { url: bridge.baseUrl, token: bridge.token });

	const attemptId = `att-${jobId}`;
	reserveAttempt(db, attemptId, jobId, Date.now());
	markIssued(db, attemptId, Date.now());
	const failure = await launchProgram(
		rt,
		job,
		rt.config.claudeBin,
		claudeResumeArgv({
			sessionId: params.sessionId,
			pluginDir,
			model: job.model,
		}),
		{
			WEZTERM_WORKER_RUN_ID: jobId,
			WEZTERM_WORKER_URL: bridge.baseUrl,
			WEZTERM_WORKER_TOKEN: bridge.token,
			WEZTERM_WORKER_HANDOVER: handoverFile(job.sessionDir),
		},
	);
	if (failure) {
		markUnused(db, attemptId, Date.now());
		job.status = "failed";
		job.error = failure;
		job.finishedAt = Date.now();
		releaseExecutionByHolder(db, jobId, Date.now());
		await bridge.close();
		rt.bridges.delete(jobId);
		rt.claudeStates.delete(jobId);
		return job;
	}
	attachAttempt(db, attemptId, job.paneId ?? -1, job.sessionFile, null, Date.now());

	/* A resumed session asks the startup questions again when it does not
	   know the workspace or the integrations. The person answers them in the
	   pane, so the extension waits for the composer. */
	await waitForComposer(rt, job.paneId);

	/* A resumed session keeps its history, and it takes no new prompt as an
	   argument. The follow-up instruction goes into the composer of the pane,
	   the way the user types it. */
	if (params.message && job.paneId !== null) {
		const failure = await typeFollowUp(rt, job.paneId, params.message);
		if (failure) {
			job.error = failure;
			rt.persist();
		}
	}
	rt.persist();
	return job;
}

/**
 * Wait until the native process of a run has ended.
 *
 * A native session keeps its id while it runs. A resume that starts before
 * the old process ended is refused by the CLI, so the resume waits first.
 */
export async function waitNativeExit(
	rt: WorkerRuntime,
	sessionId: string,
	deadlineMs: number,
): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const res = await rt.exec("powershell", [
			"-NoProfile",
			"-Command",
			`@(Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" | Where-Object { $_.CommandLine -like '*${sessionId}*' }).Count`,
		]);
		const count = Number.parseInt(res.stdout.trim(), 10);
		if (Number.isFinite(count) && count === 0) return true;
		await delay(PROCESS_POLL_MS);
	}
	return false;
}
