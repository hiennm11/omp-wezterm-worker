/**
 * The processes and the panes of a Codex worker.
 *
 * A Codex worker owns one app server and one TUI. The extension ends the
 * process of the app server only when the name of that process is
 * `codex.exe`. A process id that the system gave to another program of the
 * user must stay alive.
 */

import { createServer } from "node:net";

import type { CodexIdentity } from "./job.ts";
import { paneState } from "./pane.ts";
import { describeFailure } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";

/** The name of the process that the extension may end. */
const CODEX_PROCESS_NAME = "codex.exe";

/** One row of the process table. */
export interface CodexProcessRow {
	/** The id of the process. */
	processId: number;
	/** The name of the program of the process. */
	name: string;
	/** The command line of the process. */
	commandLine: string;
}

/**
 * The true when the extension may end a process of that name.
 *
 * The function returns true only for `codex.exe`. The child program of the
 * code mode has another name, so it never ends through this rule.
 */
export function mayEndCodexProcess(name: string): boolean {
	return name.trim().toLowerCase() === CODEX_PROCESS_NAME;
}

/**
 * The true when a process of the table is the app server of a port.
 *
 * The process must be the Codex program, its command line must hold the text
 * `app-server` and the exact address of the server.
 */
export function isCodexServerProcess(row: CodexProcessRow, port: number): boolean {
	if (!mayEndCodexProcess(row.name)) return false;
	if (!row.commandLine.includes("app-server")) return false;
	return row.commandLine.includes(`--listen ws://127.0.0.1:${port}`);
}

/**
 * Reserve a free loopback port.
 *
 * The reservation is released before the app server binds the port.
 */
export async function reserveFreePort(): Promise<number> {
	const server = createServer();
	const { promise, resolve } = Promise.withResolvers<number>();
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		server.close(() => resolve(port));
	});
	return promise;
}

/**
 * The rows of the process table that the Codex program holds.
 *
 * The command gives one object for one process and an array for many. A
 * command that fails gives an empty list.
 */
export function parseCodexProcessRows(raw: string): CodexProcessRow[] {
	const text = raw.trim();
	if (!text) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const rows = Array.isArray(parsed) ? parsed : [parsed];
	const result: CodexProcessRow[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		const value = row as { ProcessId?: unknown; Name?: unknown; CommandLine?: unknown };
		if (typeof value.ProcessId !== "number") continue;
		if (typeof value.Name !== "string") continue;
		if (typeof value.CommandLine !== "string") continue;
		result.push({
			processId: value.ProcessId,
			name: value.Name,
			commandLine: value.CommandLine,
		});
	}
	return result;
}

/**
 * The app servers of the machine that hold a port.
 *
 * The function reads the process table. It returns every process that is the
 * Codex program and that holds the address of the port.
 */
export async function findCodexServerProcesses(rt: WorkerRuntime, port: number): Promise<CodexProcessRow[]> {
	const result = await rt.exec("powershell", [
		"-NoProfile",
		"-Command",
		`Get-CimInstance Win32_Process -Filter "Name = '${CODEX_PROCESS_NAME}'" | ` +
			`Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`,
	]);
	if (result.code !== 0) return [];
	return parseCodexProcessRows(result.stdout).filter((row) => isCodexServerProcess(row, port));
}

/**
 * The name of the program of a process.
 *
 * The function returns null when the process is gone or when the table
 * cannot be read.
 */
export async function readProcessName(rt: WorkerRuntime, pid: number): Promise<string | null> {
	const result = await rt.exec("powershell", [
		"-NoProfile",
		"-Command",
		`Get-CimInstance Win32_Process -Filter "ProcessId = ${Math.trunc(pid)}" | ForEach-Object { $_.Name }`,
	]);
	if (result.code !== 0) return null;
	const name = result.stdout.trim().split("\n")[0]?.trim() ?? "";
	return name ? name : null;
}

/**
 * End the processes and the panes of a Codex worker.
 *
 * The function ends the process of the app server first. The pane of the
 * server still holds that process, so the process id cannot change to
 * another program between the check of the name and the end. Then the
 * function closes the pane of the TUI and the pane of the server.
 *
 * The function never fails. A missing pane or a missing process is not an
 * error. It returns the names of the steps that failed.
 */
export async function endCodexProcesses(
	rt: WorkerRuntime,
	identity: CodexIdentity | null,
): Promise<string[]> {
	const failed: string[] = [];
	if (!identity) return failed;

	if (identity.serverPid !== null) {
		const name = await readProcessName(rt, identity.serverPid);
		if (name !== null && mayEndCodexProcess(name)) {
			const killed = await rt.exec("taskkill", ["/PID", String(identity.serverPid), "/T", "/F"]);
			if (killed.code !== 0) failed.push(`the app server: ${describeFailure(killed)}`);
		}
	}

	if (identity.tuiPaneId !== null) {
		const closed = await closePane(rt, identity.tuiPaneId);
		if (closed) failed.push(`the pane of the TUI: ${closed}`);
	}

	if (identity.serverPaneId !== null) {
		const closed = await closePane(rt, identity.serverPaneId);
		if (closed) failed.push(`the pane of the app server: ${closed}`);
	}

	return failed;
}

/**
 * Close one pane of a Codex worker.
 *
 * A pane that is gone needs no close. The TUI can end between the read of
 * the pane list and the close, so a failed close is confirmed with a second
 * read of the pane list. The function returns the reason of a failure, or
 * null when the pane is closed or was already gone.
 */
async function closePane(rt: WorkerRuntime, paneId: number): Promise<string | null> {
	const state = await paneState(rt, paneId);
	if (state === "gone") return null;
	const closed = await rt.wezterm(["kill-pane", "--pane-id", String(paneId)]);
	if (closed.code === 0) return null;
	if ((await paneState(rt, paneId)) === "gone") return null;
	return describeFailure(closed);
}
