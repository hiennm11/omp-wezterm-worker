/**
 * The helpers that read the state of a Codex worker.
 *
 * The helpers read the database of the smoke test and the programs of the
 * machine. They never change the state of a worker.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ProcessRow } from "./codex-smoke-machine.ts";
import { type SmokeState, type ToolResult, textOf } from "./codex-smoke-shared.ts";

/** The identity of a Codex worker. */
export interface CodexIdentity {
	/** The port of the app server of the worker. */
	port: number | null;
	/** The id of the thread of the worker. */
	threadId: string | null;
	/** The pane of the TUI of the worker. */
	tuiPaneId: number | null;
	/** The pane of the app server of the worker. */
	serverPaneId: number | null;
	/** The process id of the app server of the worker. */
	serverPid: number | null;
}

/** One row of the table `executions`. */
export interface ExecutionRow {
	/** The name of the tool of the row. */
	toolName: string | null;
	/** The state of the row. */
	state: string;
	/** The kind of the row. */
	kind: string;
	/** The id of the call of the row. */
	callId: string | null;
}

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

/** The identity of a worker, read from the run row of the database. */
export function identityOf(stateDir: string, workerId: string): CodexIdentity {
	const empty: CodexIdentity = {
		port: null,
		threadId: null,
		tuiPaneId: null,
		serverPaneId: null,
		serverPid: null,
	};
	const db = openLifecycleDb(stateDir);
	if (!db) return empty;
	try {
		const rows = db.prepare("SELECT payload FROM runs WHERE id = ?").all(workerId) as Array<{
			payload: string | null;
		}>;
		const payload = rows[0]?.payload;
		if (!payload) return empty;
		const parsed = JSON.parse(payload) as {
			codex?: {
				port?: number;
				threadId?: string;
				tuiPaneId?: number | null;
				serverPaneId?: number | null;
				serverPid?: number | null;
			} | null;
		};
		const identity = parsed.codex ?? null;
		return {
			port: identity?.port ?? null,
			threadId: identity?.threadId ?? null,
			tuiPaneId: identity?.tuiPaneId ?? null,
			serverPaneId: identity?.serverPaneId ?? null,
			serverPid: identity?.serverPid ?? null,
		};
	} catch {
		return empty;
	} finally {
		db.close();
	}
}

/** The rows of the table `executions` of one run. */
export function executionRows(stateDir: string, runId: string): ExecutionRow[] {
	const db = openLifecycleDb(stateDir);
	if (!db) return [];
	try {
		const rows = db
			.prepare("SELECT tool_name, state, kind, call_id FROM executions WHERE run_id = ?")
			.all(runId) as Array<{
			tool_name: string | null;
			state: string;
			kind: string;
			call_id: string | null;
		}>;
		return rows.map((row) => ({
			toolName: row.tool_name,
			state: row.state,
			kind: row.kind,
			callId: row.call_id,
		}));
	} catch {
		return [];
	} finally {
		db.close();
	}
}

/** The number of completed reports of a run in its report file. */
export function completedReportCount(sessionDir: string, runId: string): number {
	let names: string[];
	try {
		names = readdirSync(sessionDir);
	} catch {
		return 0;
	}
	const name = names.find((entry) => entry.startsWith(".wezterm-worker-reports") && entry.endsWith(".jsonl"));
	if (!name) return 0;
	let count = 0;
	try {
		const lines = readFileSync(join(sessionDir, name), "utf8").split("\n");
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as { runId?: string; state?: string };
				if (parsed.runId !== runId) continue;
				if (parsed.state !== "completed") continue;
				count += 1;
			} catch {
				/* a partial line is normal while the file is written */
			}
		}
	} catch {
		return 0;
	}
	return count;
}

/** The status of one worker, read through the status tool. */
export async function statusText(state: SmokeState, workerId?: string): Promise<string> {
	const result = await state.host.call("wezterm_worker_status", workerId === undefined ? {} : { workerId });
	return textOf(result);
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
		await delayInState(state, 2000);
		text = await statusText(state, workerId);
	}
	return { text, found: text.includes(needle) };
}

/** Wait for a number of milliseconds. */
function delayInState(_state: SmokeState, ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * The new processes of the Codex program.
 *
 * The function reads the process table before the spawn and after it. The
 * function keeps only the processes of the Codex program, because the
 * extension starts no other program for a Codex worker.
 */
export function newCodexProcesses(before: ProcessRow[], after: ProcessRow[]): ProcessRow[] {
	return newProcesses(before, after).filter((row) => row.name.toLowerCase() === "codex.exe");
}

/**
 * The processes that the smoke test created.
 *
 * The function reads the process table before the spawn and after it. The
 * processes that the smoke test created are the new ones.
 */
export function newProcesses(before: ProcessRow[], after: ProcessRow[]): ProcessRow[] {
	return after.filter((row) => !before.some((old) => old.processId === row.processId));
}

/**
 * The worker id and the pane id of a spawn.
 *
 * The function reads the two fields of the details of the spawn. A spawn
 * that holds no worker id gives null.
 */
export function spawnIds(result: ToolResult): { workerId: string | null; paneId: number | null } {
	const details = result.details as { workerId?: string; paneId?: number } | undefined;
	return {
		workerId: typeof details?.workerId === "string" ? details.workerId : null,
		paneId: typeof details?.paneId === "number" ? details.paneId : null,
	};
}
