/**
 * The verifier of the worker eval.
 *
 * The verifier runs one command in one directory. It reports the exit code,
 * the deadline and the tail of the output. It does not decide the verdict.
 * A later slice reads the result and turns it into an acceptance verdict.
 */

import { spawnSync } from "node:child_process";

import type { VerifierResult } from "./types.ts";

/** The number of characters that the result keeps. */
const OUTPUT_TAIL_LIMIT = 2000;

/** The code that node reports when the program does not exist. */
const NO_SUCH_FILE = "ENOENT";

/** The code that node reports when the deadline passed. */
const DEADLINE_PASSED = "ETIMEDOUT";

/**
 * The environment of the verifier.
 *
 * The variable `NODE_TEST_CONTEXT` belongs to a test runner. A command that
 * starts `node --test` refuses to run when it inherits that variable, and
 * the command exits with the code 0. A verifier that runs inside a test
 * would accept every fixture, so the variable is removed.
 */
function verifierEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	delete environment.NODE_TEST_CONTEXT;
	return environment;
}

/**
 * Run one command in one directory.
 *
 * The command runs without a shell, so an argument never reaches a shell.
 * The call waits at most `timeoutMs` milliseconds.
 */
export function runVerifier(command: string[], cwd: string, timeoutMs: number): VerifierResult {
	const [program, ...args] = command;
	const startedAt = Date.now();
	const result = spawnSync(program, args, {
		cwd,
		timeout: timeoutMs,
		encoding: "utf8",
		windowsHide: true,
		env: verifierEnvironment(),
	});
	const durationMs = Date.now() - startedAt;
	const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
	const started = code !== NO_SUCH_FILE;
	const timedOut = code === DEADLINE_PASSED;
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const exitCode = started && !timedOut ? result.status : null;
	return {
		started,
		exitCode,
		timedOut,
		durationMs,
		outputTail: output.slice(-OUTPUT_TAIL_LIMIT),
	};
}
