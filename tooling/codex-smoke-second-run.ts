/**
 * The helpers that run the second session of the recovery step.
 *
 * The recovery needs two sessions with their own identity and their own
 * runtime. The second session runs in its own Node process, and it prints one
 * JSON line with its facts. The helpers of this module start that program and
 * read its facts.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

/** The facts that the second program reports. */
export interface SecondFacts {
	/** The verdict of the step. */
	verdict: string;
	/** The id of the worker after the takeover. */
	workerId: string | null;
	/** The state of the worker after the takeover. */
	status: string | null;
	/** The number of workers that the second session holds. */
	workerCount: number;
	/** Whether the takeover of the worker succeeded. */
	taken: boolean;
	/** The answer of the takeover. */
	takeover: string;
	/** The answer of the steer. */
	steer: string;
	/** The state of the worker after the steer. */
	steerStatus: string | null;
	/** The result of the report of the worker. */
	result: string | null;
	/** The reason of a failure. */
	reason: string | null;
}

/**
 * Run the second program and read its facts.
 *
 * The function starts the program with the same Node that runs the script.
 * The program prints one JSON line, and the function reads it.
 */
export function runSecond(
	stateDir: string,
	workerId: string,
	taskText: string,
): Promise<{ facts: SecondFacts | null; error: string | null }> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[join(import.meta.dirname, "codex-smoke-second.ts"), stateDir, workerId, taskText],
			{ cwd: import.meta.dirname, windowsHide: true },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error: Error) => {
			resolve({ facts: null, error: error.message });
		});
		child.on("close", () => {
			const line = stdout.split("\n").find((row) => row.trim().startsWith("{"));
			if (!line) {
				resolve({ facts: null, error: stderr.trim() || "the second program printed no facts" });
				return;
			}
			try {
				resolve({ facts: JSON.parse(line) as SecondFacts, error: null });
			} catch (error) {
				resolve({
					facts: null,
					error: `the second program printed no valid facts: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		});
	});
}
