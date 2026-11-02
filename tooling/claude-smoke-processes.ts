/**
 * The processes of the Claude smoke test.
 *
 * The helpers read the process table and keep the ids of the processes that
 * the smoke test created. They never end a process. The cleanup of the smoke
 * test ends the recorded ids, and it ends nothing else.
 *
 * A worker of Claude Code starts a helper, and the helper starts the shell
 * of every command. The shell holds the folder of the repository. A cancel
 * of the worker ends the helper, and the shell then loses its parent.
 */

import {
	allProcessRows,
	claudeProcessesOfState,
	claudeProcessRows,
	type ProcessRow,
} from "./claude-smoke-machine.ts";
import { descendantsOf } from "./claude-smoke-steps.ts";

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
 * The id of the process of a worker of the smoke test.
 *
 * The function reads the process table and gives the id of the process of
 * the worker back. A worker without a process gives null.
 */
export async function processIdOfWorker(workerId: string): Promise<number | null> {
	const rows = await claudeProcessRows();
	return claudeProcessOf(rows, workerId)?.processId ?? null;
}

/**
 * The ids of the processes that descend from a worker of the smoke test.
 *
 * The function reads the process table and gives every process that
 * descends from the worker back. A caller must call it while the worker
 * runs, because a process that lost its parent is no longer a descendant.
 */
export async function descendantIdsOfWorker(workerId: string): Promise<number[]> {
	const rows = await allProcessRows();
	const root = claudeProcessOf(rows, workerId);
	if (!root) return [];
	return descendantsOf(rows, [root.processId]);
}

/**
 * The ids of the processes that descend from any worker of the smoke test.
 *
 * The function reads the process table one time and gives every process
 * that descends from a worker of the list back. A shell of a command of a
 * worker starts while the worker runs, so a caller must call the function
 * more than once to see every shell.
 */
export async function descendantIdsOfWorkers(workerIds: Iterable<string>): Promise<number[]> {
	const ids = [...workerIds];
	if (ids.length === 0) return [];
	const rows = await allProcessRows();
	const found = new Set<number>();
	for (const workerId of ids) {
		const root = claudeProcessOf(rows, workerId);
		if (!root) continue;
		for (const pid of descendantsOf(rows, [root.processId])) found.add(pid);
	}
	return [...found];
}

/**
 * The ids of the processes of the program of Claude Code that the smoke test
 * started.
 *
 * The plugin directory of a worker of the smoke test sits in the state
 * directory of the smoke test. The command line of the process names that
 * directory, so the process belongs to the smoke test. The function never
 * reads a process of another session.
 */
export async function processIdsOfState(stateDir: string): Promise<number[]> {
	const rows = await claudeProcessRows();
	return claudeProcessesOfState(rows, stateDir).map((row) => row.processId);
}
