/**
 * Resuming a Codex worker.
 *
 * A Codex worker resumes in the same thread of Codex. The thread keeps its
 * history, so the worker comes back with the task and the answers that it
 * already produced.
 *
 * A backend change needs a new worker and a new task. The function never
 * starts a Codex thread for an OMP run or for a Claude Code run.
 *
 * A failed resume ends the app server and closes both panes, so a failed
 * resume leaves no pane and no program on the machine.
 */

import { mkdirSync } from "node:fs";

import { attachAttempt, markIssued, markUnused, reserveAttempt } from "./attempts.ts";
import { startBridge } from "./claude-bridge.ts";
import { createClaudeRunState } from "./claude-run-state.ts";
import { codexVersionRefusal, findCodexBinary } from "./codex-binary.ts";
import { type CodexLaunchDeps, launchCodex } from "./codex-launch.ts";
import { endCodexProcesses } from "./codex-process.ts";
import { codexReportLaunch } from "./codex-report.ts";
import { freeEndedHolder } from "./group-holder.ts";
import { groupOfRun, releaseExecutionByHolder, reserveExecution } from "./groups.ts";
import { freshRunState, type Job } from "./job.ts";
import { observeNative } from "./native-ledger.ts";
import { checkSourcePane } from "./resume-guard.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { writeRunContext } from "./worker-context.ts";

/** The parameters of a Codex resume. */
export interface CodexResumeParams {
	/** Id reserved by `admitLaunch`. */
	jobId: string;
	/** The run that this run resumes. */
	source: Job;
	/** The id of the thread of the source run. */
	threadId: string;
	/** The follow-up instruction, when the owner gave one. */
	message?: string;
}

/**
 * Resume a Codex worker.
 *
 * The function returns the job of the new run. A resume that fails leaves
 * the job failed with the reason.
 */
export async function resumeCodexWorker(
	rt: WorkerRuntime,
	params: CodexResumeParams,
	deps: CodexLaunchDeps = {},
): Promise<Job> {
	const { source } = params;
	const { jobId } = params;
	const job: Job = {
		...source,
		id: jobId,
		label: `${source.label} (resumed)`,
		...freshRunState(Date.now()),
		/* The new run owns a new app server and a new TUI. The identity of
		   the source run must not end the program of the source run. */
		codex: null,
	};

	/* The panes of the source run can still write into the thread of that
	   run. The resume waits until they are gone. The check comes before the
	   reservation, so a refusal holds no group and releases none. */
	const paneRefusal = await checkSourcePane(rt, source);
	if (paneRefusal) return failed(rt, job, paneRefusal);

	const db = rt.openDb();
	/* The group belongs to the session directory of the task, so a resume of
	   a resumed run takes the group of the first run of the task. */
	let group = groupOfRun(db, source);
	if (!group) {
		return failed(rt, job, `Worker ${source.id} has no resource group. It cannot be resumed.`);
	}
	/* A holder that ended keeps the group until its pane is gone. The resume
	   frees the group when the pane of the holder is gone. */
	const holderRefusal = await freeEndedHolder(rt, group);
	if (holderRefusal) return failed(rt, job, holderRefusal);
	group = groupOfRun(db, source) ?? group;
	const groupId = group.id;
	const reservation = reserveExecution(db, groupId, jobId, Date.now());
	if (!reservation.granted) return failed(rt, job, reservation.reason);

	/* The run context names the new run and the group of the task. The
	   report of the source run cannot finish the new run. */
	writeRunContext(job.sessionDir, {
		runId: jobId,
		sourceRunId: source.id,
		resourceGroup: groupId,
	});
	rt.jobs.set(jobId, job);

	const binary = await findCodexBinary(rt.exec, rt.config.codexBin);
	if (!binary) {
		releaseExecutionByHolder(db, jobId, Date.now());
		return failed(rt, job, `Cannot find the Codex program '${rt.config.codexBin}'.`);
	}
	const versionRefusal = codexVersionRefusal(binary.version);
	if (versionRefusal) {
		releaseExecutionByHolder(db, jobId, Date.now());
		return failed(rt, job, versionRefusal);
	}

	mkdirSync(job.sessionDir, { recursive: true });

	/* The new run gets a new bridge. The thread keeps its history, but the
	   run identity of the new run is new. */
	const state = createClaudeRunState(jobId);
	rt.claudeStates.set(jobId, state);
	const bridge = await startBridge(jobId, (observation) => {
		observeNative(rt, state, jobId, observation);
	});
	rt.bridges.set(jobId, bridge);

	const attemptId = `att-${jobId}`;
	reserveAttempt(db, attemptId, jobId, Date.now());
	markIssued(db, attemptId, Date.now());

	const report = codexReportLaunch({ url: bridge.baseUrl, token: bridge.token, runId: jobId });
	const launch = await launchCodex(rt, job, binary, report, deps, {
		resume: { threadId: params.threadId, message: params.message },
	});
	if (launch.error) {
		markUnused(db, attemptId, Date.now());
		releaseExecutionByHolder(db, jobId, Date.now());
		await endCodexProcesses(rt, job.codex ?? null);
		/* The client of the app server holds a socket. A failed resume
		   closes it, so the machine keeps no socket of the new run. */
		rt.codexClients.get(jobId)?.close();
		rt.codexClients.delete(jobId);
		await bridge.close();
		rt.bridges.delete(jobId);
		rt.claudeStates.delete(jobId);
		return failed(rt, job, launch.error);
	}
	attachAttempt(db, attemptId, job.paneId ?? -1, job.sessionFile, launch.threadId, Date.now());
	rt.persist();
	return job;
}

/**
 * Fail a run that never started.
 *
 * The function records the reason and the end of the run, so the owner sees
 * why the resume did not work.
 */
function failed(rt: WorkerRuntime, job: Job, reason: string): Job {
	const failedJob: Job = { ...job, status: "failed", error: reason, finishedAt: Date.now() };
	rt.jobs.set(job.id, failedJob);
	return failedJob;
}
