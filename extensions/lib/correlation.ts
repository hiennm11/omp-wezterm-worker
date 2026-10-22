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
 * The job id of a native worker command line, or null.
 *
 * A native worker loads the plugin of its run. The plugin lives in the
 * session directory of the run, and the directory name is the job id. The
 * command line of the process therefore carries the job id.
 */
export function nativeJobIdOfCommandLine(commandLine: string): string | null {
	const match = /--plugin-dir\s+"?([^"\s]*?[\\/]sessions[\\/](wz-[^"\\/]+))/i.exec(commandLine);
	if (!match) return null;
	return match[2];
}

/**
 * The workers of the process table.
 *
 * A process that runs an omp command with a session directory of a worker
 * is a worker. A process that runs a native CLI with the run id of a worker
 * in its environment is a native worker. Every other process is ignored.
 */
export function workersOf(processes: ProcessRow[]): FoundWorker[] {
	const workers: FoundWorker[] = [];
	const seen = new Set<string>();
	for (const process of processes) {
		const ompJob = /omp(\.exe)?/i.test(process.commandLine) ? jobIdOfCommandLine(process.commandLine) : null;
		const jobId = ompJob ?? nativeJobIdOfCommandLine(process.commandLine);
		if (!jobId) continue;
		if (seen.has(jobId)) continue;
		seen.add(jobId);
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
