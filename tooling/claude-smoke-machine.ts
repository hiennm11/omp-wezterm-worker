/**
 * The machine helpers of the Claude smoke test.
 *
 * The helpers read the machine. They close only what the smoke test created.
 * They never change a setting of the user, and they never touch a pane or a
 * process that the smoke test did not create.
 *
 * Every call of a program has a timeout of 20 seconds, because a call of the
 * WezTerm CLI can hang on this machine.
 */

import { execFile } from "node:child_process";

/** The timeout of one call of a program, in milliseconds. */
export const PROGRAM_TIMEOUT_MS = 20_000;

/** The name of the program of Claude Code that a worker owns. */
export const CLAUDE_PROCESS_NAME = "claude.exe";

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
	const { promise, resolve } = Promise.withResolvers<ProgramResult>();
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
	return promise;
}

/**
 * The pane ids that the WezTerm CLI lists now.
 *
 * The function gives null when the list cannot be read. An unreadable list
 * means unknown, and unknown is never a closed pane.
 */
export async function listPaneIds(): Promise<number[] | null> {
	const result = await runProgram("wezterm", ["cli", "list", "--format", "json"]);
	if (result.code !== 0) return null;
	try {
		const panes = JSON.parse(result.stdout) as Array<{ pane_id?: unknown }>;
		return panes.map((pane) => pane.pane_id).filter((id): id is number => typeof id === "number");
	} catch {
		return null;
	}
}

/**
 * The state of a pane.
 *
 * A pane that the list names is present. A pane that the list does not name
 * is gone. A list that cannot be read gives unknown, because a broken
 * WezTerm must not look like a closed pane.
 */
export async function paneState(paneId: number): Promise<"present" | "gone" | "unknown"> {
	const panes = await listPaneIds();
	if (panes === null) return "unknown";
	return panes.includes(paneId) ? "present" : "gone";
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
 * submits in the interface of Claude Code.
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
	/** The id of the process that started it. */
	parentProcessId: number | null;
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
			`Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`,
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
		const value = row as {
			ProcessId?: unknown;
			ParentProcessId?: unknown;
			Name?: unknown;
			CommandLine?: unknown;
		};
		if (typeof value.ProcessId !== "number") continue;
		if (typeof value.Name !== "string") continue;
		if (typeof value.CommandLine !== "string") continue;
		found.push({
			processId: value.ProcessId,
			name: value.Name,
			commandLine: value.CommandLine,
			parentProcessId: typeof value.ParentProcessId === "number" ? value.ParentProcessId : null,
		});
	}
	return found;
}

/**
 * The rows of the process table of every program.
 *
 * The command gives one object for one process and an array for many. A
 * command that fails gives an empty list.
 */
export async function allProcessRows(): Promise<ProcessRow[]> {
	const result = await runProgram("powershell", [
		"-NoProfile",
		"-Command",
		"Get-CimInstance Win32_Process | " +
			"Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
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
		const value = row as {
			ProcessId?: unknown;
			ParentProcessId?: unknown;
			Name?: unknown;
			CommandLine?: unknown;
		};
		if (typeof value.ProcessId !== "number") continue;
		if (typeof value.Name !== "string") continue;
		if (typeof value.CommandLine !== "string") continue;
		found.push({
			processId: value.ProcessId,
			name: value.Name,
			commandLine: value.CommandLine,
			parentProcessId: typeof value.ParentProcessId === "number" ? value.ParentProcessId : null,
		});
	}
	return found;
}

/** The rows of the process table of the program of Claude Code. */
export function claudeProcessRows(): Promise<ProcessRow[]> {
	return processRowsOf(CLAUDE_PROCESS_NAME);
}

/**
 * The processes of the program of Claude Code that the smoke test started.
 *
 * The plugin directory of a worker of the smoke test sits in the state
 * directory of the smoke test. The command line of the process names that
 * directory, so the process belongs to the smoke test. The function never
 * reads a process of another session.
 */
export function claudeProcessesOfState(rows: ProcessRow[], stateDir: string): ProcessRow[] {
	const marker = stateDir.toLowerCase();
	return rows.filter(
		(row) => row.name.toLowerCase() === "claude.exe" && row.commandLine.toLowerCase().includes(marker),
	);
}
