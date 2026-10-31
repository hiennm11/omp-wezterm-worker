/**
 * Starting a Codex worker.
 *
 * A Codex worker runs a real Codex app server in a pane of its own. A real
 * Codex TUI runs in a second pane and attaches to the thread of that server.
 * The extension sends the task as the first turn of that thread.
 *
 * The launch never changes a global setting of Codex. The extension never
 * writes into the home directory of the user.
 */

import { mkdirSync } from "node:fs";

import { attachAttempt, markIssued, markUnused, reserveAttempt } from "./attempts.ts";
import { startBridge } from "./claude-bridge.ts";
import { createClaudeRunState } from "./claude-run-state.ts";
import { codexVersionRefusal, findCodexBinary } from "./codex-binary.ts";
import { type CodexLaunchDeps, launchCodex } from "./codex-launch.ts";
import { codexReportLaunch } from "./codex-report.ts";
import { createGroup, setGroupWorktree } from "./groups.ts";
import { freshRunState, type Job } from "./job.ts";
import { finalizeJob } from "./lifecycle.ts";
import { observeNative } from "./native-ledger.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { writeRunContext } from "./worker-context.ts";
import { createWorktree } from "./worktree.ts";

export type { CodexLaunchDeps } from "./codex-launch.ts";

/** The parameters of a Codex launch. */
export interface CodexSpawnParams {
	/** Id reserved by `admitLaunch`. */
	jobId: string;
	task: string;
	cwd: string;
	label?: string;
	model?: string | null;
	/** Run in an isolated git worktree. Defaults to the config. */
	isolated?: boolean;
	/** The total deadline of the run, in ms. 0 means no deadline. */
	timeoutMs?: number;
	/** Close the pane when the worker finishes. */
	closePaneOnFinish?: boolean;
}

/**
 * Start a Codex worker.
 *
 * The function returns the job of the run. A launch that fails leaves the
 * job failed with the reason, so the tool can report it.
 */
export async function spawnCodexWorker(
	rt: WorkerRuntime,
	params: CodexSpawnParams,
	deps: CodexLaunchDeps = {},
): Promise<Job> {
	const { config } = rt;
	const { jobId } = params;
	const job: Job = {
		id: jobId,
		label: params.label || jobId,
		task: params.task,
		cwd: params.cwd,
		model: params.model ?? null,
		tools: null,
		placement: config.placement,
		sessionDir: `${config.stateDir}/sessions/${jobId}`,
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: params.timeoutMs ?? config.timeoutMs,
		idleTimeoutMs: config.idleTimeoutMs,
		closePaneOnFinish: params.closePaneOnFinish ?? config.closePaneOnFinish,
		backend: "codex",
		nativeSessionId: null,
		...freshRunState(Date.now()),
	};
	rt.jobs.set(jobId, job);
	rt.persist();

	const binary = await findCodexBinary(rt.exec, config.codexBin);
	if (!binary) {
		await finalizeJob(rt, job, "failed", missingBinaryReason(config.codexBin), null);
		return job;
	}
	const refusal = codexVersionRefusal(binary.version);
	if (refusal) {
		await finalizeJob(rt, job, "failed", refusal, null);
		return job;
	}

	mkdirSync(job.sessionDir, { recursive: true });

	/* The bridge holds the observations of the run and the commands of the
	   owner. The report server of Codex posts every report to it. */
	const state = createClaudeRunState(jobId);
	rt.claudeStates.set(jobId, state);
	const bridge = await startBridge(jobId, (observation) => {
		observeNative(rt, state, jobId, observation);
	});
	rt.bridges.set(jobId, bridge);

	const groupId = `grp-${jobId}`;
	writeRunContext(job.sessionDir, { runId: jobId, sourceRunId: null, resourceGroup: groupId });
	const db = rt.openDb();
	createGroup(db, groupId, job.sessionDir, Date.now());
	const attemptId = `att-${jobId}`;
	reserveAttempt(db, attemptId, jobId, Date.now());

	if (params.isolated ?? config.isolated) {
		try {
			const wt = await createWorktree(rt, job.cwd, jobId);
			job.worktreePath = wt.path;
			job.worktreeBranch = wt.branch;
			job.worktreeOrigin = job.cwd;
			job.cwd = wt.path;
		} catch (e) {
			markUnused(db, attemptId, Date.now());
			await finalizeJob(rt, job, "failed", e instanceof Error ? e.message : String(e), null);
			await bridge.close();
			rt.bridges.delete(jobId);
			rt.claudeStates.delete(jobId);
			return job;
		}
	}
	setGroupWorktree(db, groupId, job.worktreePath, job.worktreeOrigin, job.worktreeBranch, Date.now());

	markIssued(db, attemptId, Date.now());

	const report = codexReportLaunch({ url: bridge.baseUrl, token: bridge.token, runId: jobId });
	const launch = await launchCodex(rt, job, binary, report, deps);
	if (launch.error) {
		markUnused(db, attemptId, Date.now());
		await finalizeJob(rt, job, "failed", launch.error, null);
		await bridge.close();
		rt.bridges.delete(jobId);
		rt.claudeStates.delete(jobId);
		return job;
	}

	attachAttempt(db, attemptId, job.paneId ?? -1, job.sessionFile, launch.threadId, Date.now());
	setGroupWorktree(db, groupId, job.worktreePath, job.worktreeOrigin, job.worktreeBranch, Date.now());
	rt.persist();
	return job;
}

/**
 * The reason that the Codex program is missing.
 */
function missingBinaryReason(bin: string): string {
	return `Cannot find the Codex program '${bin}'. The extension needs the real program, not a shell.`;
}
