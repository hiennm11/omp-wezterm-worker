/**
 * The bridge handover of a native worker.
 *
 * A native worker talks to its owner over a loopback bridge. The address and
 * the token of the bridge change when the owner changes. A worker that keeps
 * running after a release must find the bridge of its new owner.
 *
 * The launch writes the address and the token into a file inside the session
 * directory. The mod reads that file on every poll. A new owner writes the
 * file again, and the worker follows it.
 *
 * The token never enters a command argument and never enters a committed
 * file. The file lives in the session directory of the run, which the
 * extension owns.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The name of the handover file inside the session directory. */
export const HANDOVER_FILE = ".wezterm-worker-bridge.json";

/** The address and the token of one bridge. */
export interface BridgeHandover {
	/** The address of the loopback bridge. */
	url: string;
	/** The token that every request must carry. */
	token: string;
}

/** The path of the handover file of a session directory. */
export function handoverFile(sessionDir: string): string {
	return join(sessionDir, HANDOVER_FILE);
}

/**
 * Write the address and the token of a bridge into the session directory.
 *
 * A new owner writes the file again, so a running worker finds it.
 */
export function writeHandover(sessionDir: string, handover: BridgeHandover): void {
	writeFileSync(handoverFile(sessionDir), JSON.stringify(handover), "utf8");
}

/**
 * Read the address and the token of a bridge from the session directory.
 *
 * A missing file or a malformed file gives null. The caller then keeps the
 * address that it already has.
 */
export function readHandover(sessionDir: string): BridgeHandover | null {
	let raw: string;
	try {
		raw = readFileSync(handoverFile(sessionDir), "utf8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const value = parsed as Partial<BridgeHandover>;
	if (typeof value.url !== "string" || !value.url) return null;
	if (typeof value.token !== "string" || !value.token) return null;
	return { url: value.url, token: value.token };
}

/**
 * Remove the handover file of a session directory.
 *
 * A released owner removes the file, so the worker stops polling a bridge
 * that nobody answers.
 */
export function clearHandover(sessionDir: string): void {
	try {
		rmSync(handoverFile(sessionDir), { force: true });
	} catch {
		/* the file is a convenience, never a requirement */
	}
}
