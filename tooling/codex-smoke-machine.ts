/**
 * The machine helpers of the Codex smoke test.
 *
 * The helpers read the machine. They never change a setting of the user and
 * they never touch a pane or a process that the smoke test did not create.
 *
 * Every call of a program has a timeout of 20 seconds, because a call of the
 * WezTerm CLI can hang on this machine.
 */

import { execFile } from "node:child_process";

/** The timeout of one call of a program, in milliseconds. */
export const PROGRAM_TIMEOUT_MS = 20_000;

/** The name of the program of Codex that a worker owns. */
const CODEX_PROCESS_NAME = "codex.exe";

/** The result of one program run. */
export interface ProgramResult {
	/** The exit code of the program. */
	code: number;
	/** The text that the program wrote to the standard output. */
	stdout: string;
	/** The text that the program wrote to the standard error. */
	stderr: string;
}

/**
 * Run one program and collect its output.
 *
 * The run ends after the timeout. A program that hangs must not hold the
 * smoke test for ever.
 */
export function runProgram(
	bin: string,
	args: string[],
	timeoutMs = PROGRAM_TIMEOUT_MS,
): Promise<ProgramResult> {
	return new Promise((resolve) => {
		execFile(
			bin,
			args,
			{ encoding: "utf8", windowsHide: true, timeout: timeoutMs },
			(error, stdout, stderr) => {
				resolve({
					code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
					stdout: stdout ?? "",
					stderr: stderr ?? "",
				});
			},
		);
	});
}

/** The pane ids that the WezTerm CLI lists now. */
export async function listPaneIds(): Promise<number[]> {
	const result = await runProgram("wezterm", ["cli", "list", "--format", "json"]);
	try {
		const panes = JSON.parse(result.stdout) as Array<{ pane_id?: unknown }>;
		return panes.map((pane) => pane.pane_id).filter((id): id is number => typeof id === "number");
	} catch {
		return [];
	}
}

/** The visible text of a pane, or an empty text when the pane is gone. */
export async function paneText(paneId: number): Promise<string> {
	const result = await runProgram("wezterm", ["cli", "get-text", "--pane-id", String(paneId)]);
	return result.code === 0 ? result.stdout : "";
}

/**
 * Send text into a pane and press Enter, the way a person does.
 *
 * The flag `--no-paste` sends the bytes as key events. A pasted block never
 * submits in the TUI of Codex.
 */
export async function sendTextToPane(paneId: number, text: string): Promise<boolean> {
	const result = await runProgram("wezterm", [
		"cli",
		"send-text",
		"--no-paste",
		"--pane-id",
		String(paneId),
		`${text}\r`,
	]);
	return result.code === 0;
}

/** Send one key into a pane. */
export async function sendKeyToPane(paneId: number, key: string): Promise<boolean> {
	const result = await runProgram("wezterm", [
		"cli",
		"send-text",
		"--no-paste",
		"--pane-id",
		String(paneId),
		key,
	]);
	return result.code === 0;
}

/** Close one pane. A pane that is already gone is not an error. */
export async function closePane(paneId: number): Promise<boolean> {
	const result = await runProgram("wezterm", ["cli", "kill-pane", "--pane-id", String(paneId)]);
	return result.code === 0;
}

/** One row of the process table. */
export interface ProcessRow {
	/** The id of the process. */
	processId: number;
	/** The name of the program of the process. */
	name: string;
	/** The command line of the process. */
	commandLine: string;
}

/**
 * The rows of the process table that carry the name of a program.
 *
 * The command gives one object for one process and an array for many. A
 * command that fails gives an empty list.
 */
export async function processRowsOf(name: string): Promise<ProcessRow[]> {
	const result = await runProgram("powershell", [
		"-NoProfile",
		"-Command",
		`Get-CimInstance Win32_Process -Filter "Name = '${name}'" | ` +
			`Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`,
	]);
	if (result.code !== 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		return [];
	}
	const rows = Array.isArray(parsed) ? parsed : [parsed];
	const found: ProcessRow[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		const value = row as { ProcessId?: unknown; Name?: unknown; CommandLine?: unknown };
		if (typeof value.ProcessId !== "number") continue;
		if (typeof value.Name !== "string") continue;
		if (typeof value.CommandLine !== "string") continue;
		found.push({
			processId: value.ProcessId,
			name: value.Name,
			commandLine: value.CommandLine,
		});
	}
	return found;
}

/** The rows of the process table of the Codex program. */
export function codexProcessRows(): Promise<ProcessRow[]> {
	return processRowsOf(CODEX_PROCESS_NAME);
}

/**
 * The process ids of the shared daemon of the user.
 *
 * The shared daemon runs `app-server --listen unix://` or `app-server daemon`.
 * A worker of the extension owns a server of its own, so the daemon of the
 * user stays outside the smoke.
 */
export function daemonProcessIds(rows: ProcessRow[]): number[] {
	return rows
		.filter(
			(row) => row.commandLine.includes("--managed-daemon") || row.commandLine.includes("app-server daemon"),
		)
		.map((row) => row.processId);
}

/** The process that runs the app server of a port. */
export function appServerProcessOf(rows: ProcessRow[], port: number): ProcessRow | null {
	const marker = `--listen ws://127.0.0.1:${port}`;
	const found = rows.find(
		(row) => row.commandLine.includes("app-server") && row.commandLine.includes(marker),
	);
	return found ?? null;
}

/** The process that runs the TUI of a port. */
export function tuiProcessOf(rows: ProcessRow[], port: number): ProcessRow | null {
	const marker = `--remote ws://127.0.0.1:${port}`;
	const found = rows.find((row) => row.commandLine.includes(marker));
	return found ?? null;
}
