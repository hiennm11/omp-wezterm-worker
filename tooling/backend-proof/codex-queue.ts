/**
 * The queue scenario of the Codex proof.
 *
 * The scenario proves that an instruction that arrives during a turn joins
 * that turn. The installed build of Codex has no method of a queue. It has
 * the method `turn/steer`, which sends a message to the model of the running
 * turn. The scenario uses that method.
 *
 * The verdict is a pure function of the facts of the scenario. A test can
 * check it without a pane.
 */

import type { Verdict } from "./evidence.ts";

/** The text that the instruction of the scenario carries. */
const QUEUE_INSTRUCTION = "Write QUEUED to queued.txt";

/**
 * The task of the queue scenario.
 *
 * The task starts a shell command that waits. The turn stays busy while the
 * command runs, so the instruction of the scenario has a turn to join.
 */
export function queueTaskText(): string {
	return "Run a shell command that waits 20 seconds. Then reply with the word DONE only.";
}

/** The parameters of one steer request. */
export interface QueueSteerParams {
	/** The thread that owns the turn. */
	threadId: string;
	/** The turn that the instruction joins. */
	expectedTurnId: string;
	/** The id that names the instruction in the native events. */
	clientUserMessageId: string;
	/** The text of the instruction. */
	input: Array<{ type: "text"; text: string }>;
	/** The protocol accepts any field of the request. */
	[key: string]: unknown;
}

/**
 * Build the parameters of the steer request of the scenario.
 *
 * The request names the turn that the instruction joins. The native program
 * refuses the request when that turn is not the running turn.
 */
export function queueSteerParams(
	threadId: string,
	turnId: string,
	clientUserMessageId: string,
): QueueSteerParams {
	return {
		threadId,
		expectedTurnId: turnId,
		clientUserMessageId,
		input: [{ type: "text", text: QUEUE_INSTRUCTION }],
	};
}

/** One observation that the scenario reads. */
interface ScenarioObservation {
	/** The native event or call that produced the observation. */
	source: string;
	/** The native payload, unchanged. */
	payload: unknown;
}

/**
 * Count the delivered instructions of the scenario.
 *
 * The native program names every instruction by its client id. The item that
 * carries the id proves that the model received the instruction.
 */
export function deliveredInstructionCount(
	observations: ScenarioObservation[],
	clientUserMessageId: string,
): number {
	return observations.filter((observation) => {
		if (observation.source !== "codex.item/started") return false;
		if (!observation.payload || typeof observation.payload !== "object") return false;
		const item = (observation.payload as { item?: { clientId?: string } }).item;
		return item?.clientId === clientUserMessageId;
	}).length;
}

/** The facts that the verdict of the queue scenario reads. */
export interface QueueFacts {
	/** Whether the native program accepted the instruction. */
	accepted: boolean;
	/** The reason of a refusal, or null when the program accepted it. */
	refusal: string | null;
	/** The number of delivered instructions. */
	delivered: number;
}

/**
 * The verdict of the queue scenario.
 *
 * The scenario passes only when the native program accepted the instruction
 * and the instruction reached the model. A refusal fails the scenario.
 */
export function queueVerdict(facts: QueueFacts): { verdict: Verdict; detail: string } {
	if (!facts.accepted) {
		return {
			verdict: "fail",
			detail: `the native program refused the instruction: ${facts.refusal ?? "unknown reason"}`,
		};
	}
	if (facts.delivered === 0) {
		return {
			verdict: "fail",
			detail: "the accepted instruction never reached the model of the running turn",
		};
	}
	return {
		verdict: "pass",
		detail: `one accepted entry became a delivered input; delivered items: ${facts.delivered}`,
	};
}
