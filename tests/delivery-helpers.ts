/**
 * The helpers of the tests of the delivery proof.
 *
 * A launch proves that the worker took its task. The proof reads the
 * session directory of the worker. A fake of a pane runtime must therefore
 * write a transcript into that directory, so the proof finds the evidence.
 *
 * The session directory is named in the argv of the OMP program. The helper
 * reads it from there, so a fake needs no extra configuration.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The name of the transcript that the helpers write. */
const TRANSCRIPT = "session.jsonl";

/**
 * The session directory of a worker, or null when the argv names none.
 *
 * The OMP program receives the session directory with the flag
 * `--session-dir`.
 */
export function sessionDirOfArgv(argv: readonly string[]): string | null {
	const at = argv.indexOf("--session-dir");
	if (at === -1) return null;
	return argv[at + 1] ?? null;
}

/**
 * Write the transcript of a worker into its session directory.
 *
 * The transcript is the evidence that the worker took its task. A session
 * directory without a transcript holds no evidence.
 */
export function writeSessionTranscript(sessionDir: string): void {
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, TRANSCRIPT), "{}\n", "utf8");
}

/**
 * The tracker of the delivery of a worker.
 *
 * The tracker learns the session directory from the argv of the agent start.
 * It writes the transcript when the task arrives. The transcript must
 * appear after the launch reads its baseline, because a transcript of the
 * size of the baseline is no evidence.
 */
export interface DeliveryTracker {
	/** Read the session directory from the argv of the agent start. */
	onStart(args: readonly string[]): void;
	/** Write the transcript, so the launch finds the evidence. */
	onPrompt(): void;
}

/**
 * The tracker of the delivery of a worker.
 *
 * The tracker writes the transcript when the prompt arrives. The argv of
 * the agent start names the session directory of the worker.
 */
export function deliveryTracker(): DeliveryTracker {
	let sessionDir: string | null = null;
	return {
		onStart(args) {
			const dash = args.indexOf("--");
			sessionDir = sessionDirOfArgv(dash < 0 ? [] : args.slice(dash + 1));
		},
		onPrompt() {
			if (sessionDir) writeSessionTranscript(sessionDir);
		},
	};
}
