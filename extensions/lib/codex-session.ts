/**
 * The session of a Codex worker.
 *
 * The session attaches the client of the app server to the run state of the
 * run. Every message of the server becomes an observation of the run, and
 * the reducer and the ledger of the run do the rest.
 *
 * The owner sends a steering instruction through the queue of Codex. The
 * request `turn/steer` sends the instruction to the model of the running
 * turn, so a running tool is not interrupted.
 */

import { randomUUID } from "node:crypto";

import { applyObservation, type ClaudeRunState } from "./claude-run-state.ts";
import type { CodexClient } from "./codex-client.ts";
import {
	advanceCodexUsage,
	type CodexUsageState,
	emptyCodexUsage,
	translateCodexMessage,
} from "./codex-events.ts";
import type { Job } from "./job.ts";
import { observeNative } from "./native-ledger.ts";
import type { WorkerRuntime } from "./runtime.ts";

/** The outcome of one steering instruction. */
export interface CodexSteerOutcome {
	/** Whether the server accepted the instruction. */
	ok: boolean;
	/** The reason of a refusal, or null when the server accepted it. */
	error: string | null;
	/** The phase that the instruction reached. */
	phase: "accepted" | "refused";
	/** The id that names the instruction in the native events. */
	commandId: string | null;
}

/**
 * Attach the events of an app server to the run state of a run.
 *
 * The function reads the run state of the run. A run without a run state
 * holds no native state, so the function does nothing. The client stays in
 * the map of the runtime, so the owner can steer the run later.
 */
export function attachCodexEvents(rt: WorkerRuntime, job: Job, client: CodexClient): boolean {
	const state = rt.claudeStates.get(job.id);
	if (!state) return false;
	let usage: CodexUsageState = emptyCodexUsage();
	client.setMessageHandler((message) => {
		const record = {
			source: message.method ?? "",
			payload: (message.params ?? {}) as Record<string, unknown>,
		};
		const observations = translateCodexMessage(record, usage);
		usage = advanceCodexUsage(record, usage);
		for (const observation of observations) {
			observeNative(rt, state, job.id, observation);
		}
	});
	rt.codexClients.set(job.id, client);
	return true;
}

/**
 * Send one steering instruction to a Codex worker.
 *
 * The function refuses the instruction while a permission request waits for
 * the person. A refused instruction is not kept for later.
 *
 * A server that accepts the instruction adds it to the pending instructions
 * of the run, as the command of a native worker does. The delivery of the
 * instruction removes it from that list.
 */
export async function steerCodex(
	client: CodexClient,
	state: ClaudeRunState,
	threadId: string,
	message: string,
): Promise<CodexSteerOutcome> {
	const open = [...state.openApprovals.keys()];
	if (open.length > 0) {
		return {
			ok: false,
			error: `The worker has an open permission request: ${open.join(", ")}. Answer it in the pane first.`,
			phase: "refused",
			commandId: null,
		};
	}
	const turnId = state.currentCycleId;
	if (!turnId) {
		return {
			ok: false,
			error: "The worker has no running turn. A steering instruction needs one.",
			phase: "refused",
			commandId: null,
		};
	}
	const clientUserMessageId = randomUUID();
	const answer = await client.request("turn/steer", {
		threadId,
		expectedTurnId: turnId,
		clientUserMessageId,
		input: [{ type: "text", text: message }],
	});
	if (answer.error) {
		return {
			ok: false,
			error: answer.error.message,
			phase: "refused",
			commandId: null,
		};
	}
	/* The server accepted the instruction. The instruction waits for its
	   delivery, so it joins the pending instructions of the run. */
	applyObservation(state, {
		backend: "codex",
		runId: state.runId,
		sessionId: state.sessionId,
		source: "command.accepted",
		payload: { id: clientUserMessageId, instructionId: clientUserMessageId },
	});
	return { ok: true, error: null, phase: "accepted", commandId: clientUserMessageId };
}
