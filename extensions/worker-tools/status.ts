/**
 * wezterm_worker_status
 */

import { statSync } from "node:fs";

import { isActive, type Job, type JobStatus } from "../lib/job.ts";
import { listSessionFiles, summarizeSession } from "../lib/transcript.ts";
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
	paneId: number | null;
	cwd: string;
	model: string | null;
	transcript: string;
	elapsedMs: number;
	idleMs: number;
	currentTool: string | null;
	turns: number;
	steers: number;
	timeoutMs: number;
	paneClosed: boolean;
	worktreePath: string | null;
	worktreeBranch: string | null;
	worktreeDirty: boolean | null;
	error: string | null;
}

function row(j: Job, now: number): StatusRow {
	return {
		workerId: j.id,
		label: j.label,
		status: j.status,
		paneId: j.paneId,
		cwd: j.cwd,
		model: j.model,
		transcript: j.sessionFile ?? j.sessionDir,
		elapsedMs: (j.finishedAt ?? now) - (j.startedAt ?? j.createdAt),
		idleMs: j.finishedAt ? 0 : now - j.lastActivityAt,
		currentTool: j.currentTool,
		turns: j.turns,
		steers: j.steers,
		timeoutMs: j.timeoutMs,
		paneClosed: j.paneClosed,
		worktreePath: j.worktreePath,
		worktreeBranch: j.worktreeBranch,
		worktreeDirty: j.worktreeDirty,
		error: j.error,
	};
}

function formatRow(r: StatusRow): string {
	return [
		`${r.workerId}  ${r.status.toUpperCase()}`,
		`  label      : ${r.label}`,
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
		`  turns     : ${r.turns}${r.steers > 0 ? ` (${r.steers} steering message(s))` : ""}`,
		r.worktreePath
			? `  worktree  : ${r.worktreePath} (branch ${r.worktreeBranch ?? "-"})` +
				(r.worktreeDirty === true ? " [has uncommitted changes]" : "")
			: null,
		r.error ? `  error     : ${r.error}` : null,
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
			"how many turns it took, and whether its pane is still alive.",
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
			const rows = jobs.map((j) => row(j, now));
			return reply(rows.map(formatRow).join("\n\n"), { workers: rows });
		},
	});
}
