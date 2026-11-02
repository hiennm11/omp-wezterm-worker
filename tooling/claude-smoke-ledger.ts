/**
 * The ledger of the Claude smoke test.
 *
 * The helpers read the state of a run of the smoke test. They read the
 * database of the state directory, the report file of a run, and the process
 * table of the machine.
 *
 * The helpers never write. They never start a program, and they never touch
 * a pane.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ProcessRow } from "./claude-smoke-machine.ts";
import { type SmokeState, type ToolResult, textOf } from "./claude-smoke-shared.ts";

/** The handle of the lifecycle database of the smoke test. */
type LifecycleHandle = InstanceType<typeof DatabaseSync>;

/**
 * Open the lifecycle database of the smoke test.
 *
 * The function opens the database of the state directory and gives the
 * handle back. A database that cannot be opened gives null.
 */
function openLifecycleDb(stateDir: string): LifecycleHandle | null {
	try {
		return new DatabaseSync(join(stateDir, "lifecycle.db"));
	} catch {
		return null;
	}
}

/**
 * The native session id of a run, read from the run row of the database.
 *
 * The payload of the run row holds the whole run. The id of the native
 * session sits in that payload.
 */
export function nativeSessionIdOf(stateDir: string, workerId: string): string | null {
	const db = openLifecycleDb(stateDir);
	if (!db) return null;
	try {
		const rows = db.prepare("SELECT payload FROM runs WHERE id = ?").all(workerId) as Array<{
			payload: string | null;
		}>;
		const payload = rows[0]?.payload;
		if (!payload) return null;
		const parsed = JSON.parse(payload) as { nativeSessionId?: unknown };
		return typeof parsed.nativeSessionId === "string" ? parsed.nativeSessionId : null;
	} catch {
		return null;
	} finally {
		db.close();
	}
}

/**
 * The report file of a run.
 *
 * The report file of a run sits in the session directory of the run. The
 * file name carries the run id, so the reports of two runs stay apart.
 */
export function reportFileOf(stateDir: string, workerId: string): string | null {
	const dir = join(stateDir, "sessions", workerId);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return null;
	}
	const name = names.find((entry) => entry.startsWith(".wezterm-worker-reports") && entry.endsWith(".jsonl"));
	if (!name) return null;
	return join(dir, name);
}

/**
 * The text of the report file of a run.
 *
 * The function reads the file and never writes into it.
 */
export function reportTextOf(stateDir: string, workerId: string): string {
	const file = reportFileOf(stateDir, workerId);
	if (!file) return "";
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/**
 * The text of the bridge log of a run.
 *
 * The bridge log holds one line per observation of the run. The file sits
 * in the session directory of the run. The function reads the file and never
 * writes into it.
 */
export function bridgeTextOf(stateDir: string, workerId: string): string {
	const file = join(stateDir, "sessions", workerId, ".wezterm-worker-bridge.jsonl");
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/** The status of one worker, read through the status tool. */
export async function statusText(state: SmokeState, workerId?: string): Promise<string> {
	const result = await state.host.call("wezterm_worker_status", workerId === undefined ? {} : { workerId });
	return textOf(result as ToolResult);
}

/** Wait until the status of a worker shows a text. */
export async function waitForStatus(
	state: SmokeState,
	workerId: string,
	needle: string,
	timeoutMs = 240_000,
): Promise<{ text: string; found: boolean }> {
	const deadline = Date.now() + timeoutMs;
	let text = await statusText(state, workerId);
	while (Date.now() < deadline) {
		if (text.includes(needle)) return { text, found: true };
		await delayInState(2000);
		text = await statusText(state, workerId);
	}
	return { text, found: text.includes(needle) };
}

/** Wait for a number of milliseconds. */
function delayInState(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * The process of the program of Claude Code that runs a worker.
 *
 * The command line of the process names the plugin directory of the run. The
 * directory sits in the session directory of the run, and the name of that
 * directory is the id of the run.
 */
export function claudeProcessOf(rows: ProcessRow[], workerId: string): ProcessRow | null {
	const marker = `sessions\\${workerId}`;
	const found = rows.find(
		(row) =>
			row.name.toLowerCase() === "claude.exe" && row.commandLine.toLowerCase().includes(marker.toLowerCase()),
	);
	return found ?? null;
}

/**
 * The processes of the program of Claude Code that the smoke test created.
 *
 * The function reads the process table before the spawn and after it. The
 * processes that the smoke test created are the new ones. The function
 * never ends a process, and it never reads a process by a name alone.
 */
export function newClaudeProcesses(before: ProcessRow[], after: ProcessRow[]): ProcessRow[] {
	const known = new Set(before.map((row) => row.processId));
	return after.filter((row) => !known.has(row.processId));
}
