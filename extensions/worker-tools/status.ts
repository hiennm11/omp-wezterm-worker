/**
 * wezterm_worker_status
 */

import { statSync } from "node:fs";

import { backendLabel, readBackend } from "../lib/backend.ts";
import { pendingEvents, type WorkerEvent } from "../lib/events.ts";
import { isActive, type Job, type JobStatus } from "../lib/job.ts";
import { completionBlockerOf } from "../lib/ledger-sync.ts";
import { nativeJobUsageReport, requestUsageOf } from "../lib/native-usage-report.ts";
import { reportState } from "../lib/report-decision.ts";
import { readReports } from "../lib/report-store.ts";
import { snapshotNotice, turnsLabel } from "../lib/restored-run.ts";
import type { WorkerRuntime } from "../lib/runtime.ts";
import { listSessionFiles, summarizeSession } from "../lib/transcript.ts";
import { formatUsage, jobUsage, requestWorkerIds, type UsageReport } from "../lib/usage.ts";
import { reply, type ToolDeps } from "./kit.ts";

/**
 * Re-read the transcript so the reported activity is current rather than the
 * value from the last monitor tick.
 */
function refreshActivity(job: Job, now: number): void {
	if (!isActive(job)) return;
	const files = listSessionFiles(job.sessionDir);
	if (files.length === 0) return;
	const summary = summarizeSession(files[0]);
	job.sessionFile = files[0];
	job.currentTool = summary.currentTool;
	job.turns = summary.turns;
	try {
		const size = statSync(files[0]).size;
		if (size !== job.lastTranscriptSize) {
			job.lastActivityAt = now;
			job.lastTranscriptSize = size;
		}
	} catch {
		/* the transcript is being written; the next poll retries */
	}
}

/** One worker as the status tool reports it. */
interface StatusRow {
	workerId: string;
	label: string;
	status: JobStatus;
	backend: string;
	paneId: number | null;
	cwd: string;
	model: string | null;
	transcript: string;
	elapsedMs: number;
	idleMs: number;
	currentTool: string | null;
	turns: number;
	/** The turn count with the words of a restored run. */
	turnsText: string;
	/** The measured token usage of this worker. */
	usage: UsageReport;
	steers: number;
	timeoutMs: number;
	paneClosed: boolean;
	worktreePath: string | null;
	worktreeBranch: string | null;
	worktreeDirty: boolean | null;
	stop: string | null;
	error: string | null;
	/** The result of the task, for a finished worker. */
	result: string | null;
	/** The native state of the run, for a native worker. */
	native: string | null;
	/** The reason that the completion of the run cannot be accepted. */
	blocked: string | null;
}

function row(j: Job, now: number, usage: UsageReport, rt: WorkerRuntime): StatusRow {
	const backend = readBackend(j);
	/* A native worker reports its usage through its bridge. The OMP reader
	   finds no transcript, so the native totals are the measured ones. */
	const measured = backend === "omp" ? usage : nativeJobUsageReport(j, rt.claudeStates.get(j.id) ?? null);
	/* A restart cut the counts of a native run. The row says that the
	   counts start at the restart. */
	const restored = isRestored(rt, j);
	const turns =
		backend === "omp" ? j.turns : (rt.claudeStates.get(j.id)?.cycles.length ?? j.nativeCycles ?? 0);
	return {
		workerId: j.id,
		label: j.label,
		status: j.status,
		backend: backendLabel(backend),
		paneId: j.paneId,
		cwd: j.cwd,
		model: j.model,
		transcript: j.sessionFile ?? j.sessionDir,
		elapsedMs: (j.finishedAt ?? now) - (j.startedAt ?? j.createdAt),
		idleMs: j.finishedAt ? 0 : now - j.lastActivityAt,
		currentTool: j.currentTool,
		turns,
		turnsText: turnsLabel(turns, restored),
		usage: measured,
		steers: j.steers,
		timeoutMs: j.timeoutMs,
		paneClosed: j.paneClosed,
		worktreePath: j.worktreePath,
		worktreeBranch: j.worktreeBranch,
		worktreeDirty: j.worktreeDirty,
		stop:
			j.pendingStop === null
				? null
				: j.pendingStop.failure === null
					? "in progress"
					: `not confirmed (${j.pendingStop.failure}). Call wezterm_worker_cancel to retry.`,
		error: j.error,
		result: j.result,
		native: nativeSummary(rt, j),
		blocked: completionBlocker(rt, j),
	};
}

/**
 * The truth that a restart cut the counts of a native run.
 *
 * The live state holds the time of the restart. A finished run keeps it on
 * the job.
 */
function isRestored(rt: WorkerRuntime, job: Job): boolean {
	if (readBackend(job) === "omp") return false;
	return typeof (rt.claudeStates.get(job.id)?.usage.restoredAt ?? job.nativeUsage?.restoredAt) === "number";
}

/**
 * The reason that the completion of a worker cannot be accepted.
 *
 * A worker that reported completion but still holds an outstanding execution
 * cannot end. The line names the blocker, so the owner sees why the worker
 * is still running.
 */
function completionBlocker(rt: WorkerRuntime, job: Job): string | null {
	if (!isActive(job)) return null;
	const reports = readReports(job.sessionDir, job.id);
	const { state } = reportState(reports);
	if (state !== "completed") return null;
	return completionBlockerOf(rt.openDb(), job.id);
}

/**
 * The native state of a run, for the status row.
 *
 * A native worker reports through its own bridge. The state names the
 * current cycle, the open calls and the open permission requests.
 */
function nativeSummary(rt: WorkerRuntime, job: Job): string | null {
	if (readBackend(job) === "omp") return null;
	const state = rt.claudeStates.get(job.id);
	if (!state) {
		/* A finished native run holds no state. Its cycles and its reports
		   stay on the job, so the summary still names them. */
		if (job.nativeCycles === undefined) return "no native state";
		return `${job.nativeCycles} cycle(s), finished`;
	}
	const notice = snapshotNotice(isRestored(rt, job), state.snapshotAt);
	return (
		`cycle ${state.currentCycleId ?? "-"}, ${state.openCalls.size} open call(s), ` +
		`${state.openApprovals.size} open approval(s), ${state.reports.length} report(s)` +
		(notice === null ? "" : `, ${notice}`)
	);
}

/**
 * One event that waits for the owner.
 *
 * The line names the event id, the condition and the worker. The owner
 * acknowledges the event with its id.
 */
function formatEvent(event: WorkerEvent): string {
	return `  ${event.id}  ${event.condition}  (worker ${event.runId})`;
}

function formatRow(r: StatusRow): string {
	return [
		`${r.workerId}  ${r.status.toUpperCase()}`,
		`  label      : ${r.label}`,
		`  backend   : ${r.backend}`,
		`  pane      : ${r.paneId === null ? "-" : r.paneClosed ? "(closed)" : r.paneId}`,
		`  cwd       : ${r.cwd}`,
		`  model     : ${r.model ?? "(default)"}`,
		`  transcript: ${r.transcript}`,
		`  elapsed   : ${Math.round(r.elapsedMs / 1000)}s` +
			(r.timeoutMs > 0 ? ` (timeout at ${Math.round(r.timeoutMs / 1000)}s)` : " (no timeout)"),
		r.status === "running" || r.status === "queued"
			? `  idle      : ${Math.round(r.idleMs / 1000)}s since last activity`
			: null,
		r.currentTool ? `  running   : ${r.currentTool}` : null,
		r.result ? `  result    : ${r.result}` : null,
		r.native ? `  native    : ${r.native}` : null,
		`  turns     : ${r.turnsText}${r.steers > 0 ? ` (${r.steers} steering message(s))` : ""}`,
		`  tokens    : ${formatUsage(r.usage)}`,
		r.worktreePath
			? `  worktree  : ${r.worktreePath} (branch ${r.worktreeBranch ?? "-"})` +
				(r.worktreeDirty === true ? " [has uncommitted changes]" : "")
			: null,
		r.stop ? `  stop      : ${r.stop}` : null,
		r.error ? `  error     : ${r.error}` : null,
		r.blocked ? `  Completion blocked: ${r.blocked}` : null,
	]
		.filter((line): line is string => line !== null)
		.join("\n");
}

export function registerStatusTool({ pi, rt }: ToolDeps): void {
	const z = pi.zod;
	pi.registerTool({
		name: "wezterm_worker_status",
		label: "WezTerm Worker Status",
		description:
			"List the WezTerm pane workers of this session, or inspect one by id. " +
			"Returns lifecycle state (queued/running/completed/failed/cancelled), pane id, cwd, transcript path, " +
			"elapsed time, time since the last worker activity, the tool the worker is running right now, " +
			"how many turns it took, the tokens it used, and whether its pane is still alive.",
		parameters: z.object({
			workerId: z.string().optional().describe("Inspect a single worker. Omit to list all."),
		}),
		loadMode: "essential",
		async execute(_id: string, params: { workerId?: string }) {
			const all = [...rt.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
			const jobs = params.workerId ? all.filter((j) => j.id === params.workerId) : all;
			if (jobs.length === 0) {
				return reply(
					params.workerId
						? `Unknown worker id: ${params.workerId}`
						: "No workers have been spawned in this process.",
					{ workers: [] },
					Boolean(params.workerId),
				);
			}
			const now = Date.now();
			for (const job of jobs) refreshActivity(job, now);
			const rows = jobs.map((j) => row(j, now, jobUsage(j), rt));
			const request = requestUsageOf(rt.jobs, rt.requestLaunches, rt.claudeStates);
			const count = requestWorkerIds(rt.jobs, rt.requestLaunches).length;
			/* An event that nobody handled waits for the owner. The owner
			   finds it here, because the acknowledgement needs the event
			   id, and the event id lives nowhere else. */
			const events = pendingEvents(rt.openDb()).filter((event) => jobs.some((job) => job.id === event.runId));
			const text =
				rows.map(formatRow).join("\n\n") +
				`\n\nThis request: ${formatUsage(request)} across ${count} worker(s). ` +
				"The main session is not counted." +
				(events.length > 0 ? `\n\nEvents that wait for you:\n${events.map(formatEvent).join("\n")}` : "");
			return reply(text, { workers: rows, requestUsage: request, events });
		},
	});
}
