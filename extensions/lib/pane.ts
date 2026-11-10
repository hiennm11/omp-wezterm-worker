/**
 * The panes of a worker.
 *
 * Every function here touches only the pane ids it is given. No function
 * lists panes to act on them, so a pane that belongs to the user is never
 * touched.
 *
 * The functions dispatch on the runtime of the job. A worker keeps the
 * runtime that started it, so a tool that acts on the worker later uses the
 * same runtime.
 *
 * A job without a runtime has an unknown runtime. A tool that acts on such a
 * job reports that its runtime is unknown. The extension never guesses Herdr
 * for a run that the database holds from an older version.
 */

import type { Job } from "./job.ts";
import {
	herdrClosePaneConfirmed,
	herdrKillPane,
	herdrPaneState,
	herdrPaneStatesOf,
	herdrPaneTail,
	herdrSendToPane,
	type PaneState,
} from "./pane-herdr.ts";
import type { PaneRuntime } from "./pane-runtime.ts";
import {
	weztermClosePaneConfirmed,
	weztermKillPane,
	weztermPaneState,
	weztermPaneStatesOf,
	weztermPaneTail,
	weztermSendToPane,
} from "./pane-wezterm.ts";
import type { WorkerRuntime } from "./runtime.ts";

export type { PaneState };

/**
 * The runtime of a job, or null when the job has no runtime.
 *
 * The function reads the field of the job. A run that the database holds
 * from an older version has no field, so the runtime stays unknown.
 */
export function runtimeOf(job: Job | undefined): PaneRuntime | null {
	if (!job) return null;
	return job.runtime ?? null;
}

/**
 * The reason that the pane of a job cannot be read, or null when it can.
 *
 * A job without a runtime has an unknown runtime. The message names the
 * runtime and the worker, so the user knows what to fix.
 */
export function unknownRuntimeRefusal(job: Job | undefined): string | null {
	if (runtimeOf(job) !== null) return null;
	const id = job?.id ?? "this worker";
	return (
		`The runtime of worker ${id} is unknown. ` +
		"The pane of that worker cannot be read, because the run was stored before the runtime existed."
	);
}

/**
 * The state of the pane of a job.
 *
 * A job without a runtime gives "unknown", because the extension cannot read
 * a pane without a runtime.
 */
export async function paneState(rt: WorkerRuntime, job: Job): Promise<PaneState> {
	const runtime = runtimeOf(job);
	if (runtime === null) return "unknown";
	if (job.paneId === null) return "gone";
	if (runtime === "wezterm") return weztermPaneState(rt, job.paneId);
	return herdrPaneState(rt, job.paneId);
}

/**
 * The state of the pane of every given job.
 *
 * The function reads the pane list one time for every runtime. It returns one
 * entry for every job that it received. A job without a runtime gives
 * "unknown".
 */
export async function paneStatesOf(rt: WorkerRuntime, jobs: readonly Job[]): Promise<Map<string, PaneState>> {
	const states = new Map<string, PaneState>();
	if (jobs.length === 0) return states;
	const herdrIds: string[] = [];
	const weztermIds: string[] = [];
	for (const job of jobs) {
		const runtime = runtimeOf(job);
		if (job.paneId === null) continue;
		if (runtime === "herdr") herdrIds.push(job.paneId);
		else if (runtime === "wezterm") weztermIds.push(job.paneId);
	}
	const herdrStates =
		herdrIds.length > 0 ? await herdrPaneStatesOf(rt, herdrIds) : new Map<string, PaneState>();
	const weztermStates =
		weztermIds.length > 0 ? await weztermPaneStatesOf(rt, weztermIds) : new Map<string, PaneState>();
	for (const job of jobs) {
		if (job.paneId === null) continue;
		const runtime = runtimeOf(job);
		if (runtime === "herdr") states.set(job.paneId, herdrStates.get(job.paneId) ?? "unknown");
		else if (runtime === "wezterm") states.set(job.paneId, weztermStates.get(job.paneId) ?? "unknown");
		else states.set(job.paneId, "unknown");
	}
	return states;
}

/**
 * Send text into the pane of a running worker and submit it.
 *
 * A job without a runtime refuses the send, because the extension cannot
 * name the pane without a runtime.
 */
export async function sendToPane(
	rt: WorkerRuntime,
	job: Job,
	text: string,
): Promise<{ ok: boolean; error: string | null }> {
	const runtime = runtimeOf(job);
	if (runtime === null) return { ok: false, error: unknownRuntimeRefusal(job) };
	if (job.paneId === null) return { ok: false, error: `Worker ${job.id} has no pane.` };
	if (runtime === "wezterm") return weztermSendToPane(rt, job.paneId, text);
	return herdrSendToPane(rt, job.paneId, text);
}

/**
 * Read the last few visible lines of the pane of a worker.
 *
 * This is a debug aid for a stalled worker, never a result source: the
 * worker's transcript stays the only authority on what the worker produced.
 */
export async function paneTail(rt: WorkerRuntime, job: Job, lines: number): Promise<string> {
	const runtime = runtimeOf(job);
	if (runtime === null || job.paneId === null) return "";
	if (runtime === "wezterm") return weztermPaneTail(rt, job.paneId, lines);
	return herdrPaneTail(rt, job.paneId, lines);
}

/** Ask the runtime to close the pane of a worker. Returns the failure reason, or null when the request was accepted. */
export async function killPane(rt: WorkerRuntime, job: Job): Promise<string | null> {
	const runtime = runtimeOf(job);
	if (runtime === null) return unknownRuntimeRefusal(job);
	if (job.paneId === null) return null;
	if (runtime === "wezterm") return weztermKillPane(rt, job.paneId);
	return herdrKillPane(rt, job.paneId);
}

/**
 * Close the pane of a worker and wait until the pane list shows it is gone.
 *
 * Returns null when the close is confirmed, else the reason.
 */
export async function closePaneConfirmed(rt: WorkerRuntime, job: Job): Promise<string | null> {
	const runtime = runtimeOf(job);
	if (runtime === null) return unknownRuntimeRefusal(job);
	if (job.paneId === null) return null;
	if (runtime === "wezterm") return weztermClosePaneConfirmed(rt, job.paneId);
	return herdrClosePaneConfirmed(rt, job.paneId);
}
