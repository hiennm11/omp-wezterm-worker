/**
 * The events of a Codex worker.
 *
 * The translator turns the messages of the app server into the observations
 * of a native run. The reducer and the ledger then do the rest. The tests
 * read the real messages of the Codex proof of 2026-10-31.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	applyObservation,
	type ClaudeRunState,
	claudeCompletionBlocker,
	createClaudeRunState,
} from "../extensions/lib/claude-run-state.ts";
import {
	advanceCodexUsage,
	type CodexUsageState,
	emptyCodexUsage,
	translateCodexMessage,
} from "../extensions/lib/codex-events.ts";
import { executionsOfRun } from "../extensions/lib/executions.ts";
import { observeNative } from "../extensions/lib/native-ledger.ts";
import { nativeRuntime } from "./native-run-helpers.ts";

/** One message of the app server, as the proof recorded it. */
interface RecordedMessage {
	source: string;
	payload: Record<string, unknown>;
}

/** The real messages of the proof. */
const MESSAGES = JSON.parse(
	readFileSync(join(import.meta.dirname, "fixtures", "codex-messages.json"), "utf8"),
) as Record<string, RecordedMessage | RecordedMessage[]>;

/** The messages of the proof that one key names. */
function messagesOf(key: string): RecordedMessage[] {
	const value = MESSAGES[key];
	if (!value) throw new Error(`the fixture holds no message '${key}'`);
	return Array.isArray(value) ? value : [value];
}

/** One message of the proof that one key names. */
function messageOf(key: string): RecordedMessage {
	return messagesOf(key)[0];
}

/** The state of a run that reads a list of messages. */
function stateAfter(messages: RecordedMessage[]): ClaudeRunState {
	const state = createClaudeRunState("run-1");
	let usage: CodexUsageState = emptyCodexUsage();
	for (const message of messages) {
		for (const observation of translateCodexMessage(message, usage)) {
			applyObservation(state, observation);
		}
		usage = advanceCodexUsage(message, usage);
	}
	return state;
}

/** The usage that the payload of a turn completion carries. */
function usageOfPayload(payload: unknown): Record<string, number> | null {
	if (!payload || typeof payload !== "object") return null;
	if (!("usage" in payload)) return null;
	const usage = payload.usage;
	if (!usage || typeof usage !== "object") return null;
	return usage as Record<string, number>;
}

/** The usage of the turn that ends after the given messages. */
function usageAfter(messages: RecordedMessage[]): Record<string, number> | null {
	let usage: CodexUsageState = emptyCodexUsage();
	let found: Record<string, number> | null = null;
	for (const message of messages) {
		for (const observation of translateCodexMessage(message, usage)) {
			if (observation.source !== "turn.complete") continue;
			found = usageOfPayload(observation.payload);
		}
		usage = advanceCodexUsage(message, usage);
	}
	return found;
}

test("a real turn starts the cycle of the run", () => {
	const state = stateAfter([messageOf("turnStarted1")]);
	assert.equal(state.currentCycleId, "turn-1");
	assert.deepEqual(state.cycles, ["turn-1"]);
});

test("a real turn ends the cycle of the run", () => {
	const state = stateAfter([messageOf("turnStarted1"), messageOf("turnCompleted1")]);
	assert.equal(state.completedTurns.has("turn-1"), true);
});

test("the usage of the first turn is its total", () => {
	const usage = usageAfter([
		messageOf("turnStarted1"),
		...messagesOf("tokenUsageTurn1"),
		messageOf("turnCompleted1"),
	]);
	assert.equal(usage?.input_tokens, 59495);
	assert.equal(usage?.output_tokens, 173);
	assert.equal(usage?.cache_read_input_tokens, 58368);
	assert.equal(usage?.cache_creation_input_tokens, 0);
});

test("the usage of a turn is the change of the totals", () => {
	/* A turn that starts after an update of the thread has a base. The
	   usage of that turn is the difference between the base and the last
	   update of the turn. */
	const usage = usageAfter([
		messagesOf("tokenUsageTurn1")[3],
		messageOf("turnStarted2"),
		...messagesOf("tokenUsageTurn2"),
		messageOf("turnCompleted2"),
	]);
	assert.equal(usage?.input_tokens, 105067 - 59495);
	assert.equal(usage?.output_tokens, 281 - 173);
	assert.equal(usage?.cache_read_input_tokens, 103168 - 58368);
});

test("the second turn does not count the first turn again", () => {
	const first = usageAfter([
		messageOf("turnStarted1"),
		...messagesOf("tokenUsageTurn1"),
		messageOf("turnCompleted1"),
	]);
	const second = usageAfter([
		messageOf("turnStarted1"),
		...messagesOf("tokenUsageTurn1"),
		messageOf("turnCompleted1"),
		messageOf("turnStarted2"),
		...messagesOf("tokenUsageTurn2"),
		messageOf("turnCompleted2"),
	]);
	assert.equal(first?.input_tokens, 59495);
	assert.equal(second?.input_tokens, 105067 - 59495);
	assert.equal(second?.output_tokens, 281 - 173);
});

test("a field that the update does not hold stays missing", () => {
	const message: RecordedMessage = {
		source: "thread/tokenUsage/updated",
		payload: {
			threadId: "thread-1",
			turnId: "turn-1",
			tokenUsage: {
				total: { totalTokens: 10, inputTokens: 10, outputTokens: 2 },
				last: { totalTokens: 10, inputTokens: 10, outputTokens: 2 },
			},
		},
	};
	const usage = usageAfter([messageOf("turnStarted1"), message, messageOf("turnCompleted1")]);
	assert.equal(usage?.input_tokens, 10);
	assert.equal("cache_read_input_tokens" in (usage ?? {}), false);
	assert.equal("cache_creation_input_tokens" in (usage ?? {}), false);
});

test("a command item opens a call", () => {
	const state = stateAfter([messageOf("commandItemStarted")]);
	assert.equal(state.openCalls.size, 1);
	assert.equal([...state.openCalls.values()][0], "commandExecution");
});

test("the completion of a command item settles its call", () => {
	const state = stateAfter([messageOf("commandItemStarted"), messageOf("commandItemCompleted")]);
	assert.equal(state.openCalls.size, 0);
	assert.equal(state.settledCalls.size, 1);
});

test("a call to the report tool opens no row", () => {
	const { rt } = nativeRuntime();
	try {
		const state = createClaudeRunState("run-1");
		let usage: CodexUsageState = emptyCodexUsage();
		for (const message of [messageOf("reportItemStarted"), messageOf("reportItemCompleted")]) {
			for (const observation of translateCodexMessage(message, usage)) {
				observeNative(rt, state, "run-1", observation);
			}
			usage = advanceCodexUsage(message, usage);
		}
		const rows = executionsOfRun(rt.openDb(), "run-1");
		assert.equal(rows.length, 0);
		assert.equal(state.openCalls.size, 0);
	} finally {
		rt.closeDb();
	}
});

test("an approval request puts an entry in the open approvals", () => {
	const state = stateAfter([messageOf("approvalRequest")]);
	assert.equal(state.openApprovals.size, 1);
	assert.equal([...state.openApprovals.keys()][0], "exec-492ddd8e-0b98-488d-8cc5-4ae915817260");
});

test("the completion of the item closes its approval request", () => {
	const state = stateAfter([messageOf("approvalRequest"), messageOf("commandItemCompleted")]);
	assert.equal(state.openApprovals.size, 0);
});

test("an open approval blocks the completion of the run", () => {
	const state = stateAfter([messageOf("turnStarted1"), messageOf("approvalRequest")]);
	assert.match(claudeCompletionBlocker(state) ?? "", /permission request/);
});

test("an open call blocks the completion of the run", () => {
	const state = stateAfter([messageOf("turnStarted1"), messageOf("commandItemStarted")]);
	assert.match(claudeCompletionBlocker(state) ?? "", /have not settled/);
});

test("a pending instruction blocks the completion of the run", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, {
		backend: "codex",
		runId: "run-1",
		sessionId: null,
		source: "command.accepted",
		payload: { id: "cmd-1", instructionId: "cmd-1" },
	});
	assert.match(claudeCompletionBlocker(state) ?? "", /wait for their cycle/);
});

test("a replayed message changes nothing", () => {
	const once = stateAfter([messageOf("turnStarted1"), messageOf("commandItemStarted")]);
	const twice = stateAfter([
		messageOf("turnStarted1"),
		messageOf("commandItemStarted"),
		messageOf("turnStarted1"),
		messageOf("commandItemStarted"),
	]);
	assert.deepEqual(twice.cycles, once.cycles);
	assert.equal(twice.openCalls.size, once.openCalls.size);
});

test("an unknown message gives no observation", () => {
	const observations = translateCodexMessage({ source: "warning", payload: {} }, emptyCodexUsage());
	assert.deepEqual(observations, []);
});
