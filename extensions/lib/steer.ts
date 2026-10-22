/**
 * Steering a running worker.
 *
 * A steer call sends one instruction into the pane of a running worker. The
 * extension never sends that instruction twice. The transcript is the only
 * evidence that the worker took the instruction, because WezTerm accepts the
 * keystrokes without knowing what the worker does with them.
 */

import type { Job } from "./job.ts";
import { sendToPane } from "./pane.ts";
import { delay } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { listSessionFiles, summarizeSession } from "./transcript.ts";

/** The number of checks of the transcript after one send. */
const CONFIRM_POLLS = 60;
/** The wait between two checks of the transcript. */
const CONFIRM_STEP_MS = 500;

/** The options of one steering call. A test sets a short wait. */
export interface SteerOptions {
	/** The wait between two checks of the transcript, in ms. */
	confirmDelayMs?: number;
}

/**
 * The outcome of one steering call.
 *
 * `ok` is true only when the transcript records the requested text. A false
 * `ok` means that the delivery is not confirmed. The error names the reason.
 */
export interface SteerOutcome {
	ok: boolean;
	error: string | null;
	attempts: number;
}

/**
 * The user messages that the worker's transcript records, in order.
 *
 * The order matters, because only the messages that the transcript gained
 * after the send can confirm that send.
 */
function recordedUserMessages(sessionDir: string): string[] {
	const files = listSessionFiles(sessionDir);
	if (files.length === 0) return [];
	return summarizeSession(files[0]).userMessages;
}

/**
 * The messages that the transcript gained after the send.
 *
 * Each recorded text is matched against the messages of the baseline. A text
 * that the baseline already held does not confirm the send, unless the
 * transcript records that text again. The comparison uses the trimmed text,
 * so a change of spacing does not look like a new message.
 */
function freshMessages(before: string[], after: string[]): string[] {
	const remaining = new Map<string, number>();
	for (const text of before) {
		const key = text.trim();
		remaining.set(key, (remaining.get(key) ?? 0) + 1);
	}
	const fresh: string[] = [];
	for (const text of after) {
		const key = text.trim();
		const count = remaining.get(key) ?? 0;
		if (count > 0) {
			remaining.set(key, count - 1);
		} else {
			fresh.push(key);
		}
	}
	return fresh;
}

/**
 * Steer a worker and confirm the message.
 *
 * The extension sends the instruction once. A worker needs a few seconds to
 * start its interface, so the keystrokes can reach the pane before the
 * worker takes them. The transcript decides, so the extension reads it after
 * the send and compares the new messages with the requested text.
 *
 * A send that the transcript does not confirm stays unconfirmed. The
 * extension never sends the instruction again, because a second copy of the
 * same instruction reaches the worker as a second instruction.
 */
export async function steerWorker(
	rt: WorkerRuntime,
	job: Job,
	paneId: number,
	message: string,
	options: SteerOptions = {},
): Promise<SteerOutcome> {
	const wanted = message.trim();
	const before = recordedUserMessages(job.sessionDir);
	const sent = await sendToPane(rt, paneId, message);
	if (!sent.ok) {
		return {
			ok: false,
			error:
				`WezTerm refused to send the text into pane ${paneId}: ${sent.error}. ` +
				"The worker did not receive the instruction.",
			attempts: 1,
		};
	}
	const step = options.confirmDelayMs ?? CONFIRM_STEP_MS;
	for (let poll = 0; poll < CONFIRM_POLLS; poll++) {
		await delay(step);
		const after = recordedUserMessages(job.sessionDir);
		if (freshMessages(before, after).includes(wanted)) {
			return { ok: true, error: null, attempts: 1 };
		}
	}
	return {
		ok: false,
		error:
			`WezTerm accepted the text for pane ${paneId}, but the worker's transcript does not record the instruction. ` +
			"The delivery is unconfirmed.",
		attempts: 1,
	};
}
