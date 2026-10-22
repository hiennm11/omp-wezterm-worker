/**
 * Steering a worker that runs a native backend.
 *
 * A native worker takes a steering instruction through its bridge. The mod
 * submits the instruction with the native prompt API, so a running tool is
 * not interrupted.
 *
 * The function returns the phase that the native program reached. A receipt
 * is not an acceptance. The acceptance is the native acceptance of the
 * instruction, and the delivery is the cycle that carries it.
 */

import type { BridgeState } from "./claude-bridge.ts";
import type { ClaudeRunState } from "./claude-run-state.ts";
import { delay } from "./process.ts";

/** The phases that a command reaches. */
export type CommandPhase = "received" | "accepted" | "delivered" | "refused";

/** The outcome of one steering instruction. */
export interface SteerOutcome {
	ok: boolean;
	error: string | null;
	phase: CommandPhase | null;
	commandId: string | null;
}

/** How long the function waits for the native acceptance. */
const ACCEPT_TIMEOUT_MS = 20_000;

/** How long the function waits between two polls. */
const POLL_STEP_MS = 250;

/**
 * Send one instruction to a native worker.
 *
 * The function queues the instruction and waits for the native acceptance.
 * A permission request that is still open refuses the instruction, and the
 * refusal is not saved for later.
 */
export async function steerNative(
	bridge: BridgeState,
	state: ClaudeRunState,
	message: string,
): Promise<SteerOutcome> {
	if (state.openApprovals.size > 0) {
		return {
			ok: false,
			error: "The worker has an open permission request. Answer it in the pane first.",
			phase: "refused",
			commandId: null,
		};
	}
	const commandId = `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	bridge.commands.push({ id: commandId, runId: state.runId, text: message });

	const deadline = Date.now() + ACCEPT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const result = bridge.results.get(commandId);
		if (result) {
			if (result.phase === "refused") {
				return {
					ok: false,
					error: result.error ?? "the worker refused the instruction",
					phase: "refused",
					commandId,
				};
			}
			if (result.phase === "accepted" || result.phase === "delivered") {
				return { ok: true, error: null, phase: result.phase, commandId };
			}
		}
		await delay(POLL_STEP_MS);
	}
	return {
		ok: false,
		error: "The worker did not accept the instruction within the timeout.",
		phase: "received",
		commandId,
	};
}
