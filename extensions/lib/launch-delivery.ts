/**
 * The proof that a worker took its task.
 *
 * A launch must prove that the task reached the worker. The OMP TUI renders
 * a long multi-line task as a pasted block in the composer. The Enter of the
 * agent prompt does not submit that block. The worker never starts then, and
 * the launch has no evidence for its success message.
 *
 * The proof waits for the evidence. The evidence is one of two facts:
 *
 * - a session file that the send created;
 * - a transcript that grew past the size that it had before the send.
 *
 * The launch sends one Enter when the evidence stays absent. The Enter
 * submits the pasted block. It is not a second instruction, so the task text
 * is never sent twice.
 *
 * The check of the evidence is a pure function of the session directory and
 * of the clock. A test needs no pane.
 */

import { statSync } from "node:fs";

import type { Job } from "./job.ts";
import { delay, describeFailure } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { listSessionFiles } from "./transcript.ts";

/** How long the launch waits between two polls of the evidence. */
export const DELIVERY_POLL_MS = 1000;

/** How many polls the launch makes before the Enter and after it. */
export const DELIVERY_ATTEMPTS = 30;

/** The bound of the wait for the evidence. */
export interface DeliveryBound {
	/** The wait between two polls, in ms. */
	intervalMs: number;
	/** The number of polls before the Enter and after it. */
	attempts: number;
}

/** The default bound of the wait for the evidence. */
export const DEFAULT_DELIVERY_BOUND: DeliveryBound = {
	intervalMs: DELIVERY_POLL_MS,
	attempts: DELIVERY_ATTEMPTS,
};

/** The state of the session directory before the send of the task. */
export interface DeliveryBaseline {
	/** The size of every transcript that the session directory held before the send. */
	readonly sizes: ReadonlyMap<string, number>;
}

/** The result of the wait for the evidence. */
export interface DeliveryResult {
	/** True when the worker took the task. */
	delivered: boolean;
	/** The reason that the task was not delivered, or null. */
	error: string | null;
}

/** The action that the launch takes after a poll that found no evidence. */
export type DeliveryAction = "wait" | "enter" | "fail";

/** The size of a file, or zero when the file cannot be read. */
function sizeOf(file: string): number {
	try {
		return statSync(file).size;
	} catch {
		return 0;
	}
}

/**
 * The state of the session directory before the send of the task.
 *
 * A resume shares its session directory with the run that it resumes. The
 * size of the old transcript must be known before the send, because the old
 * transcript proves nothing about the delivery of the task.
 */
export function deliveryBaseline(sessionDir: string): DeliveryBaseline {
	const sizes = new Map<string, number>();
	for (const file of listSessionFiles(sessionDir)) sizes.set(file, sizeOf(file));
	return { sizes };
}

/**
 * The evidence that the worker took the task.
 *
 * The function checks two facts in this order. A session file that the send
 * created proves the delivery. A transcript that grew past the size that it
 * had before the send proves it too.
 */
export function deliveryEvidence(sessionDir: string, baseline: DeliveryBaseline): boolean {
	const files = listSessionFiles(sessionDir);
	if (files.some((file) => !baseline.sizes.has(file))) return true;
	return files.some((file) => sizeOf(file) > (baseline.sizes.get(file) ?? 0));
}

/**
 * The action that the launch takes after a poll that found no evidence.
 *
 * The function is a pure function of the polls, of the Enter, and of the
 * bound. The launch waits for the evidence, then sends one Enter, then waits
 * again. A launch that finds no evidence after the Enter fails.
 */
export function deliveryAction(
	polls: number,
	entered: boolean,
	bound: DeliveryBound = DEFAULT_DELIVERY_BOUND,
): DeliveryAction {
	if (entered) return polls >= bound.attempts ? "fail" : "wait";
	return polls >= bound.attempts ? "enter" : "wait";
}

/** The reason that the task did not reach the worker. */
function notDelivered(job: Job, detail: string | null): string {
	const pane = job.paneId ?? "(none)";
	const reason = `The task was not delivered to the worker in pane ${pane}.`;
	return detail ? `${reason} ${detail}` : reason;
}

/**
 * Wait for the evidence that the worker took the task.
 *
 * The function sends one Enter when the evidence stays absent. It never
 * sends the task text again. The Enter submits the pasted block of the
 * composer, so it is not a second instruction.
 */
export async function awaitDelivery(
	rt: WorkerRuntime,
	job: Job,
	baseline: DeliveryBaseline,
	bound: DeliveryBound = DEFAULT_DELIVERY_BOUND,
): Promise<DeliveryResult> {
	let polls = 0;
	let entered = false;
	for (;;) {
		if (deliveryEvidence(job.sessionDir, baseline)) return { delivered: true, error: null };
		const action = deliveryAction(polls, entered, bound);
		if (action === "fail") {
			return { delivered: false, error: notDelivered(job, null) };
		}
		if (action === "enter") {
			const failure = await sendEnter(rt, job);
			if (failure !== null) {
				return { delivered: false, error: notDelivered(job, failure) };
			}
			entered = true;
			polls = 0;
			continue;
		}
		polls += 1;
		await delay(bound.intervalMs);
	}
}

/**
 * Send the Enter key into the pane of the worker.
 *
 * The key name is the name that Herdr takes. The function returns the reason
 * of the refusal, or null when Herdr accepted the key press.
 */
async function sendEnter(rt: WorkerRuntime, job: Job): Promise<string | null> {
	if (job.paneId === null) return "The worker has no pane, so the Enter key went nowhere.";
	const res = await rt.herdr(["pane", "send-keys", job.paneId, "enter"]);
	if (res.code === 0) return null;
	return `Herdr refused the Enter key: ${describeFailure(res)}.`;
}
