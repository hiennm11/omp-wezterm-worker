/**
 * The worker registry.
 *
 * The registry is a file, not just a map. A worker that is still running when
 * OMP restarts would otherwise be lost, so every worker is written to disk
 * and read back by the next process.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Job, JobStatus } from "./job.ts";

/** The registry file inside the state directory. */
export function registryFile(stateDir: string): string {
	return join(stateDir, "registry.json");
}

/**
 * Write the registry to disk.
 *
 * The write is atomic: a temp file plus a rename, so a crash mid-write
 * cannot leave a truncated registry that would fail to parse on the next read.
 */
export function persistRegistry(stateDir: string, jobs: Iterable<Job>): void {
	const payload = JSON.stringify({ version: 1, jobs: [...jobs].map((job) => ({ ...job })) }, null, "\t");
	const file = registryFile(stateDir);
	const tmp = `${file}.tmp`;
	try {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(tmp, payload, "utf8");
		renameSync(tmp, file);
	} catch {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* the temp file is best-effort cleanup */
		}
	}
}

/**
 * Read the registry back from disk.
 *
 * Jobs that were still running when the process ended are only useful if their
 * pane is still alive, so those are returned separately: a caller re-attaches
 * a monitor to them, while finished jobs are just history.
 */
export function loadRegistry(stateDir: string): { finished: Job[]; alive: Job[] } {
	const finished: Job[] = [];
	const alive: Job[] = [];
	let raw: string;
	try {
		raw = readFileSync(registryFile(stateDir), "utf8");
	} catch {
		return { finished, alive };
	}
	let parsed: { version?: number; jobs?: unknown };
	try {
		parsed = JSON.parse(raw) as typeof parsed;
	} catch {
		return { finished, alive };
	}
	if (!Array.isArray(parsed.jobs)) return { finished, alive };
	for (const entry of parsed.jobs as Array<Record<string, unknown>>) {
		if (!entry || typeof entry.id !== "string") continue;
		const job = restoreJob(entry);
		// A job that was running when the process died can be picked up again
		// only if its pane still exists.
		if ((job.status === "running" || job.status === "queued") && job.paneId !== null) {
			alive.push(job);
		} else {
			finished.push(job);
		}
	}
	return { finished, alive };
}

/** Rebuild a job from its persisted form, dropping fields of the wrong type. */
function restoreJob(entry: Record<string, unknown>): Job {
	const status = entry.status;
	return {
		id: entry.id as string,
		label: typeof entry.label === "string" ? entry.label : (entry.id as string),
		task: typeof entry.task === "string" ? entry.task : "",
		cwd: typeof entry.cwd === "string" ? entry.cwd : "",
		model: typeof entry.model === "string" ? entry.model : null,
		tools: Array.isArray(entry.tools) ? entry.tools.map(String) : null,
		status: isJobStatus(status) ? status : "completed",
		paneId: typeof entry.paneId === "number" ? entry.paneId : null,
		tabId: typeof entry.tabId === "number" ? entry.tabId : null,
		windowId: typeof entry.windowId === "number" ? entry.windowId : null,
		placement: entry.placement === "tab" ? "tab" : "split",
		sessionDir: typeof entry.sessionDir === "string" ? entry.sessionDir : "",
		sessionFile: typeof entry.sessionFile === "string" ? entry.sessionFile : null,
		createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
		startedAt: typeof entry.startedAt === "number" ? entry.startedAt : null,
		finishedAt: typeof entry.finishedAt === "number" ? entry.finishedAt : null,
		result: typeof entry.result === "string" ? entry.result : null,
		error: typeof entry.error === "string" ? entry.error : null,
		worktreePath: typeof entry.worktreePath === "string" ? entry.worktreePath : null,
		worktreeBranch: typeof entry.worktreeBranch === "string" ? entry.worktreeBranch : null,
		worktreeOrigin: typeof entry.worktreeOrigin === "string" ? entry.worktreeOrigin : null,
		worktreeDirty: typeof entry.worktreeDirty === "boolean" ? entry.worktreeDirty : null,
		cancelled: entry.cancelled === true,
		lastActivityAt: typeof entry.lastActivityAt === "number" ? entry.lastActivityAt : Date.now(),
		currentTool: typeof entry.currentTool === "string" ? entry.currentTool : null,
		turns: typeof entry.turns === "number" ? entry.turns : 0,
		baselineTurns: typeof entry.baselineTurns === "number" ? entry.baselineTurns : 0,
		steers: typeof entry.steers === "number" ? entry.steers : 0,
		lastTranscriptSize: typeof entry.lastTranscriptSize === "number" ? entry.lastTranscriptSize : 0,
		timeoutMs: typeof entry.timeoutMs === "number" ? entry.timeoutMs : 0,
		idleTimeoutMs: typeof entry.idleTimeoutMs === "number" ? entry.idleTimeoutMs : 0,
		closePaneOnFinish: entry.closePaneOnFinish !== false,
		paneClosed: entry.paneClosed === true,
	};
}

function isJobStatus(value: unknown): value is JobStatus {
	return (
		value === "queued" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled"
	);
}
