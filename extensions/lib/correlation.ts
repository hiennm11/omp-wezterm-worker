/**
 * The correlation of a live worker with its launch attempt.
 *
 * The launch command carries the session directory of the worker. The
 * session directory names the job. The process table gives the command line
 * of every running process, so the recovery can find a worker that a crash
 * left without a receipt.
 */

import { basename } from "node:path";

import type { FoundWorker } from "./recovery.ts";

/** One process of the process table. */
export interface ProcessRow {
	processId: number;
	commandLine: string;
}

/**
 * The job id of a worker command line, or null.
 *
 * The launch passes the session directory of the worker. The directory name
 * is the job id.
 */
export function jobIdOfCommandLine(commandLine: string): string | null {
	const match = /--session-dir\s+"?([^"\s]+)"?/i.exec(commandLine);
	if (!match) return null;
	const dir = match[1].replace(/\\/g, "/");
	const name = basename(dir);
	return name.startsWith("wz-") ? name : null;
}

/**
 * The workers of the process table.
 *
 * A process that runs an omp command with a session directory of a worker
 * is a worker. Every other process is ignored.
 */
export function workersOf(processes: ProcessRow[]): FoundWorker[] {
	const workers: FoundWorker[] = [];
	for (const process of processes) {
		if (!/omp(\.exe)?/i.test(process.commandLine)) continue;
		const jobId = jobIdOfCommandLine(process.commandLine);
		if (!jobId) continue;
		workers.push({
			jobId,
			paneId: null,
			sessionId: null,
			sessionFile: null,
		});
	}
	return workers;
}

/**
 * The pane id of a worker command line, or null.
 *
 * The pane of a worker holds the variable WEZTERM_PANE. The command line
 * does not carry it, so the pane comes from the process table of the host.
 */
export function paneIdOfCommandLine(commandLine: string): number | null {
	const match = /WEZTERM_PANE[=:](\d+)/.exec(commandLine);
	if (!match) return null;
	const value = Number.parseInt(match[1], 10);
	return Number.isFinite(value) ? value : null;
}
