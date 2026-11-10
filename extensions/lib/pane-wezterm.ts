/**
 * The WezTerm panes.
 *
 * Every function here touches only the pane ids it is given. No function
 * lists panes to act on them, so a pane that belongs to the user is never
 * touched.
 *
 * The pane id of a job is a string. The CLI of WezTerm names its panes with
 * a number, so the functions here convert the number at the boundary.
 */

import { delay, describeFailure } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";
import type { PaneState } from "./pane-herdr.ts";
import { weztermPaneNumber } from "./pane-id.ts";

/**
 * The pane ids of a pane list, or null when the list cannot be read.
 *
 * The reply of `wezterm cli list --format json` is a list of panes. Every
 * pane has the id `pane_id`.
 */
function parsePaneIds(stdout: string): Set<string> | null {
	const panes = parseJson(stdout);
	if (!Array.isArray(panes)) return null;
	const ids = new Set<string>();
	for (const entry of panes) {
		if (typeof entry !== "object" || entry === null) continue;
		const paneId = memberOf(entry, "pane_id");
		if (typeof paneId !== "number") continue;
		ids.add(String(paneId));
	}
	return ids;
}

/** The parsed JSON of a reply, or null when the reply is not JSON. */
function parseJson(stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch {
		return null;
	}
}

/** A member of a parsed reply, or null when it is not there. */
function memberOf(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return null;
	if (!(key in value)) return null;
	return (value as Record<string, unknown>)[key];
}

/** An unreadable pane list is "unknown", never "gone": a broken CLI must not look like a closed pane. */
export async function weztermPaneState(rt: WorkerRuntime, paneId: string): Promise<PaneState> {
	const listing = await rt.wezterm(["list", "--format", "json"]);
	if (listing.code !== 0) return "unknown";
	const ids = parsePaneIds(listing.stdout);
	if (ids === null) return "unknown";
	return ids.has(paneId) ? "present" : "gone";
}

/**
 * The state of every given pane id.
 *
 * The function reads the pane list one time, whatever the number of ids. An
 * unreadable list makes every entry "unknown".
 */
export async function weztermPaneStatesOf(
	rt: WorkerRuntime,
	paneIds: readonly string[],
): Promise<Map<string, PaneState>> {
	const states = new Map<string, PaneState>();
	if (paneIds.length === 0) return states;
	const listing = await rt.wezterm(["list", "--format", "json"]);
	const ids = listing.code === 0 ? parsePaneIds(listing.stdout) : null;
	for (const paneId of paneIds) {
		if (ids === null) states.set(paneId, "unknown");
		else states.set(paneId, ids.has(paneId) ? "present" : "gone");
	}
	return states;
}

/**
 * Send text into a running worker's composer and submit it.
 *
 * `wezterm cli send-text` pastes by default, and a pasted block never submits
 * in the OMP TUI: the text lands in the composer but the Enter key does not
 * arrive, so the worker sits there waiting.
 *
 * `--no-paste` sends the bytes as individual key events instead of a
 * bracketed paste, so the trailing "\r" is delivered as a real Enter and the
 * composer submits. The "\r" is appended here, never by the caller.
 */
export async function weztermSendToPane(
	rt: WorkerRuntime,
	paneId: string,
	text: string,
): Promise<{ ok: boolean; error: string | null }> {
	const number = weztermPaneNumber(paneId);
	if (number === null) return { ok: false, error: `The pane id ${paneId} is not a WezTerm pane id.` };
	const res = await rt.wezterm(["send-text", "--no-paste", "--pane-id", String(number), `${text}\r`]);
	if (res.code !== 0) return { ok: false, error: describeFailure(res) };
	return { ok: true, error: null };
}

/**
 * Read the last few visible lines of a pane.
 *
 * This is a debug aid for a stalled worker, never a result source: the
 * worker's transcript stays the only authority on what the worker produced.
 */
export async function weztermPaneTail(rt: WorkerRuntime, paneId: string, lines: number): Promise<string> {
	const number = weztermPaneNumber(paneId);
	if (number === null) return "";
	const res = await rt.wezterm(["get-text", "--pane-id", String(number)]);
	if (res.code !== 0) return "";
	const rows = res.stdout.split("\n").filter((l) => l.trim());
	return rows.slice(-lines).join("\n");
}

/** Ask WezTerm to close one pane. Returns the failure reason, or null when the request was accepted. */
export async function weztermKillPane(rt: WorkerRuntime, paneId: string): Promise<string | null> {
	const number = weztermPaneNumber(paneId);
	if (number === null) return `The pane id ${paneId} is not a WezTerm pane id.`;
	const res = await rt.wezterm(["kill-pane", "--pane-id", String(number)]);
	return res.code === 0 ? null : describeFailure(res);
}

/**
 * Close one pane and wait until the pane list shows it is gone.
 *
 * The function returns null when the close is confirmed, else the reason. A
 * failed kill still polls, because "pane not found" means the pane is gone.
 */
export async function weztermClosePaneConfirmed(
	rt: WorkerRuntime,
	paneId: string,
): Promise<string | null> {
	const killFailure = await weztermKillPane(rt, paneId);
	const { attempts, intervalMs } = rt.stopConfirm;
	let last: PaneState = "present";
	for (let attempt = 0; attempt < attempts; attempt++) {
		last = await weztermPaneState(rt, paneId);
		if (last === "gone") return null;
		if (attempt < attempts - 1) await delay(intervalMs);
	}
	if (killFailure !== null) return `WezTerm refused to close pane ${paneId}: ${killFailure}`;
	if (last === "unknown")
		return `The WezTerm pane list cannot be read, so the close of pane ${paneId} is not confirmed.`;
	return `Pane ${paneId} is still open after the close request.`;
}
