/**
 * The second session of the recovery step of the Codex smoke test.
 *
 * The program has its own host on the state directory of the smoke test. It
 * takes the worker over, steers it, and waits for the report of the worker.
 * It prints one JSON line with its facts, so the smoke test can read them.
 *
 * The program runs in its own Node process, because the recovery needs two
 * sessions with their own identity and their own runtime.
 *
 * Run it with:
 *
 *   node tooling/codex-smoke-second.ts <state dir> <worker id> <task text>
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/* The module must load before the extension. It removes the variables that
   make the extension a worker. */
import "./codex-smoke-env.ts";
import { createHost, sessionContext } from "../tests/harness.ts";
import { textOf } from "./codex-smoke-shared.ts";

/** The facts that the program reports. */
interface SecondFacts {
	/** The verdict of the step. */
	verdict: "pass" | "fail";
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

/** The text of the report of the worker, or an empty text. */
function workerResult(status: string): string | null {
	const match = /result\s+:\s*(.+)/.exec(status);
	return match ? match[1].trim() : null;
}

/** The state of one worker, read from the text of the status tool. */
function workerState(status: string, workerId: string): string | null {
	const line = status.split("\n").find((row) => row.startsWith(`${workerId}  `));
	if (!line) return null;
	const state = line.slice(workerId.length + 2).trim();
	return state.length > 0 ? state : null;
}

/** Run the second session of the recovery step. */
async function main(): Promise<number> {
	const [stateDir, workerId, taskText] = process.argv.slice(2);
	if (!stateDir || !workerId || !taskText) {
		process.stdout.write(
			`${JSON.stringify({ verdict: "fail", reason: "the program needs a state directory, a worker id and a task text" })}\n`,
		);
		return 1;
	}
	const facts: SecondFacts = {
		verdict: "fail",
		workerId: null,
		status: null,
		workerCount: 0,
		taken: false,
		takeover: "",
		steer: "",
		steerStatus: null,
		result: null,
		reason: null,
	};
	if (!existsSync(join(stateDir, "lifecycle.db"))) {
		facts.reason = `the state directory ${stateDir} holds no database`;
		process.stdout.write(`${JSON.stringify(facts)}\n`);
		return 1;
	}

	const sessionId = `smoke-second-${Date.now()}`;
	const host = createHost({ stateDir, cwd: stateDir, sessionId });
	await host.fire("session_start", sessionContext(stateDir, sessionId));

	try {
		const taken = await host.call("wezterm_worker_takeover", { workerId });
		facts.takeover = textOf(taken);
		facts.taken = (taken.details as { taken?: boolean })?.taken === true;

		const status = await host.call("wezterm_worker_status", {});
		const statusText = textOf(status);
		facts.workerCount = (status.details as { workers?: unknown[] })?.workers?.length ?? 0;
		facts.workerId = workerId;
		facts.status = workerState(statusText, workerId);

		if (!facts.taken) {
			facts.reason = `the takeover was refused: ${facts.takeover}`;
			process.stdout.write(`${JSON.stringify(facts)}\n`);
			return 1;
		}

		const steered = await host.call("wezterm_worker_steer", {
			workerId,
			message: taskText,
		});
		facts.steer = textOf(steered);

		const deadline = Date.now() + 240_000;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 2000));
			const after = await host.call("wezterm_worker_status", { workerId });
			const afterText = textOf(after);
			facts.steerStatus = workerState(afterText, workerId);
			const result = workerResult(afterText);
			if (result !== null) {
				facts.result = result;
				break;
			}
			if (facts.steerStatus === "COMPLETED") break;
		}

		if (facts.result === null) {
			facts.reason = `the report of the worker did not reach the second session: ${facts.steer}`;
			process.stdout.write(`${JSON.stringify(facts)}\n`);
			return 1;
		}
		facts.verdict = "pass";
		process.stdout.write(`${JSON.stringify(facts)}\n`);
		return 0;
	} catch (error) {
		facts.reason = error instanceof Error ? error.message : String(error);
		process.stdout.write(`${JSON.stringify(facts)}\n`);
		return 1;
	} finally {
		await host.cleanup().catch(() => undefined);
	}
}

process.exit(await main());
