/**
 * The process table of the machine.
 *
 * The recovery reads it to find a worker that a crash left without a
 * receipt. An unreadable process table means unknown, never dead.
 */

import { type ProcessRow, workersOf } from "./correlation.ts";
import { describeFailure } from "./process.ts";
import type { FoundWorker } from "./recovery.ts";
import type { WorkerRuntime } from "./runtime.ts";

/**
 * The processes of the machine that run a worker.
 *
 * The command uses the same seam as every other program. A command that
 * fails gives an empty list, and the recovery treats every attempt as
 * unresolved.
 */
export async function findLiveWorkers(rt: WorkerRuntime): Promise<FoundWorker[]> {
	const result = await rt.exec("powershell", [
		"-NoProfile",
		"-Command",
		"Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
	]);
	if (result.code !== 0) {
		rt.errors.push(`The process table cannot be read: ${describeFailure(result)}`);
		return [];
	}
	return workersOf(parseProcessRows(result.stdout));
}

/**
 * The rows of the process table.
 *
 * The command gives one object for one process and an array for many. A
 * command that gives nothing gives an empty list.
 */
export function parseProcessRows(raw: string): ProcessRow[] {
	const text = raw.trim();
	if (!text) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const rows = Array.isArray(parsed) ? parsed : [parsed];
	const result: ProcessRow[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		const value = row as { ProcessId?: unknown; CommandLine?: unknown };
		if (typeof value.ProcessId !== "number") continue;
		if (typeof value.CommandLine !== "string") continue;
		result.push({ processId: value.ProcessId, commandLine: value.CommandLine });
	}
	return result;
}

/**
 * The start time of one process.
 *
 * The start time tells two incarnations of the same process id apart. A
 * process that does not exist gives `startedAt: null`. A command that fails
 * gives `ok: false`, and the caller treats the process as unknown, never as
 * gone.
 */
export async function readProcessStart(
	rt: WorkerRuntime,
	processId: number,
): Promise<{ ok: true; startedAt: string | null } | { ok: false }> {
	/* PowerShell keeps the exit code of the last command. A suppressed error
	   still sets that code, so a script with `; exit 0` would hide a real
	   failure too. The script therefore names the one failure that means the
	   process is gone, and it gives every other failure a nonzero code. */
	const script =
		`try { $p = Get-Process -Id ${Math.trunc(processId)} -ErrorAction Stop } ` +
		`catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { exit 0 }; exit 1 }; ` +
		`try { $p.StartTime.ToUniversalTime().ToString('o') } catch { exit 1 }; exit 0`;
	const result = await rt.exec("powershell", ["-NoProfile", "-Command", script]);
	if (result.code !== 0) {
		rt.errors.push(`The start time of process ${processId} cannot be read: ${describeFailure(result)}`);
		return { ok: false };
	}
	return { ok: true, startedAt: result.stdout.trim() || null };
}
