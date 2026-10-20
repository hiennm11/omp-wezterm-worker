/**
 * Steering a running worker.
 */

import type { Job } from "./job.ts";
import { sendToPane } from "./pane.ts";
import { delay } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { listSessionFiles, summarizeSession } from "./transcript.ts";

const MAX_ATTEMPTS = 8;
const CONFIRM_POLLS = 10;
const CONFIRM_STEP_MS = 500;

/**
 * The number of user messages in a worker's transcript.
 *
 * The count is the evidence that a steering message arrived. The keystrokes
 * can reach the pane before the worker starts its TUI, and then they go
 * nowhere.
 */
export function userMessageCount(sessionDir: string): number {
	const files = listSessionFiles(sessionDir);
	if (files.length === 0) return 0;
	return summarizeSession(files[0]).userMessages.length;
}

/**
 * Steer a worker and confirm that the message arrived.
 *
 * The keystrokes reach the pane as soon as the pane exists. The worker needs
 * a few seconds to start its TUI, and keystrokes that arrive before that go
 * nowhere. The tool must not report success in that case, so the transcript
 * is read after every attempt and the send is repeated until the message
 * shows up there.
 */
export async function steerWorker(
	rt: WorkerRuntime,
	job: Job,
	paneId: number,
	message: string,
): Promise<{ ok: boolean; error: string | null; attempts: number }> {
	const before = userMessageCount(job.sessionDir);
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const sent = await sendToPane(rt, paneId, message);
		if (!sent.ok) return { ok: false, error: sent.error, attempts: attempt };
		// Give the worker a moment to write the message into its transcript.
		for (let poll = 0; poll < CONFIRM_POLLS; poll++) {
			await delay(CONFIRM_STEP_MS);
			if (userMessageCount(job.sessionDir) > before) {
				return { ok: true, error: null, attempts: attempt };
			}
		}
	}
	return {
		ok: false,
		error:
			"The worker did not accept the message. Its pane may not have started its interface yet. " +
			"Try again in a few seconds.",
		attempts: MAX_ATTEMPTS,
	};
}
