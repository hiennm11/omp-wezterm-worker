/**
 * Herdr panes.
 *
 * Every function here touches only the pane ids it is given. No function
 * lists panes to act on them, so a pane that belongs to the user is never
 * touched.
 *
 * The pane id is a string such as `w4:p1`. Herdr names the panes, and the
 * extension never builds an id.
 */

import { delay, describeFailure } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";

export type PaneState = "present" | "gone" | "unknown";

/**
 * The pane ids of a pane list, or null when the list cannot be read.
 *
 * The reply of Herdr holds the panes under `result.panes`. Every pane has
 * the id `pane_id`.
 */
function parsePaneIds(stdout: string): Set<string> | null {
	const reply = parseJson(stdout);
	if (reply === null) return null;
	const result = memberOf(reply, "result");
	if (result === null) return null;
	const panes = memberOf(result, "panes");
	if (!Array.isArray(panes)) return null;
	const ids = new Set<string>();
	for (const entry of panes) {
		if (typeof entry !== "object" || entry === null) continue;
		const paneId = memberOf(entry, "pane_id");
		if (typeof paneId !== "string") continue;
		ids.add(paneId);
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

/**
 * A member of a parsed reply, or null when it is not there.
 *
 * The reply of Herdr comes from a program, so the shape is unknown. The
 * function narrows the value instead of trusting it.
 */
function memberOf(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return null;
	if (!(key in value)) return null;
	return (value as Record<string, unknown>)[key];
}

/** An unreadable pane list is "unknown", never "gone": a broken CLI must not look like a closed pane. */
export async function paneState(rt: WorkerRuntime, paneId: string): Promise<PaneState> {
	const listing = await rt.herdr(["pane", "list"]);
	if (listing.code !== 0) return "unknown";
	const ids = parsePaneIds(listing.stdout);
	if (ids === null) return "unknown";
	return ids.has(paneId) ? "present" : "gone";
}

/**
 * The state of every given pane id.
 *
 * The function reads the pane list one time, whatever the number of ids. It
 * returns one entry for every id that it received. An unreadable list makes
 * every entry "unknown", because a broken CLI must not look like a closed
 * pane.
 */
export async function paneStatesOf(
	rt: WorkerRuntime,
	paneIds: readonly string[],
): Promise<Map<string, PaneState>> {
	const states = new Map<string, PaneState>();
	if (paneIds.length === 0) return states;
	const listing = await rt.herdr(["pane", "list"]);
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
 * `agent prompt` sends the text and the Enter key in one call. The worker
 * takes the text as one instruction.
 */
export async function sendToPane(
	rt: WorkerRuntime,
	paneId: string,
	text: string,
): Promise<{ ok: boolean; error: string | null }> {
	const res = await rt.herdr(["agent", "prompt", paneId, text]);
	if (res.code !== 0) return { ok: false, error: describeFailure(res) };
	return { ok: true, error: null };
}

/**
 * Read the last few visible lines of a pane.
 *
 * This is a debug aid for a stalled worker, never a result source: the
 * worker's transcript stays the only authority on what the worker produced.
 */
export async function paneTail(rt: WorkerRuntime, paneId: string, lines: number): Promise<string> {
	const res = await rt.herdr([
		"pane",
		"read",
		paneId,
		"--source",
		"recent-unwrapped",
		"--lines",
		String(lines),
	]);
	if (res.code !== 0) return "";
	const rows = res.stdout.split("\n").filter((l) => l.trim());
	return rows.slice(-lines).join("\n");
}

/** Ask Herdr to close one pane. Returns the failure reason, or null when the request was accepted. */
export async function killPane(rt: WorkerRuntime, paneId: string): Promise<string | null> {
	const res = await rt.herdr(["pane", "close", paneId]);
	return res.code === 0 ? null : describeFailure(res);
}

/** Close one pane and wait until the pane list shows it is gone. Returns null when confirmed, else the reason. */
export async function closePaneConfirmed(rt: WorkerRuntime, paneId: string): Promise<string | null> {
	// A failed kill still polls: "pane not found" means the pane is already gone.
	const killFailure = await killPane(rt, paneId);
	const { attempts, intervalMs } = rt.stopConfirm;
	let last: PaneState = "present";
	for (let attempt = 0; attempt < attempts; attempt++) {
		last = await paneState(rt, paneId);
		if (last === "gone") return null;
		if (attempt < attempts - 1) await delay(intervalMs);
	}
	if (killFailure !== null) return `Herdr refused to close pane ${paneId}: ${killFailure}`;
	if (last === "unknown")
		return `The Herdr pane list cannot be read, so the close of pane ${paneId} is not confirmed.`;
	return `Pane ${paneId} is still open after the close request.`;
}
