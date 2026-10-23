import assert from "node:assert/strict";
import { test } from "node:test";

import {
	applyObservation,
	claudeBoundReport,
	claudeCompletionBlocker,
	createClaudeRunState,
} from "../extensions/lib/claude-run-state.ts";

/** One observation of a native program. */
function observation(source: string, payload: unknown) {
	return {
		backend: "claude",
		runId: "run-1",
		sessionId: "session-1",
		source,
		payload,
	};
}

test("a native turn starts the cycle of the run", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("turn.start", { turnId: "turn-1" }));
	assert.equal(state.currentCycleId, "turn-1");
	assert.deepEqual(state.cycles, ["turn-1"]);
});

test("a repeated turn start does not start a second cycle", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("turn.start", { turnId: "turn-1" }));
	applyObservation(state, observation("turn.start", { turnId: "turn-1" }));
	assert.deepEqual(state.cycles, ["turn-1"]);
});

test("a call settles only when the same call settles", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("tool.call.opened", { callId: "call-1", tool: "Bash" }));
	assert.equal(state.openCalls.size, 1);
	applyObservation(state, observation("tool.call.settled", { callId: "call-1", denied: false }));
	assert.equal(state.openCalls.size, 0);
	assert.equal(state.settledCalls.get("call-1")?.denied, false);
});

test("a failed call leaves the open calls and the completion blocker", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("tool.call.opened", { callId: "call-1", tool: "Bash" }));
	applyObservation(state, observation("tool.call.failed", { callId: "call-1", tool: "Bash" }));
	assert.equal(state.openCalls.size, 0);
	assert.equal(state.settledCalls.size, 0);
	assert.equal(claudeCompletionBlocker(state), null);
});

test("a failed call closes its permission request", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("tool.check", { callId: "call-1", tool: "Bash", decision: "ask" }));
	applyObservation(state, observation("tool.call.failed", { callId: "call-1", tool: "Bash" }));
	assert.equal(state.openApprovals.size, 0);
});

test("a permission decision of ask holds the request open", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("tool.check", { callId: "call-1", tool: "Bash", decision: "ask" }));
	assert.equal(state.openApprovals.size, 1);
});

test("a settled call closes its permission request", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("tool.check", { callId: "call-1", tool: "Bash", decision: "ask" }));
	applyObservation(state, observation("tool.call.settled", { callId: "call-1" }));
	assert.equal(state.openApprovals.size, 0);
});

test("an open permission request blocks the completion", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("tool.check", { callId: "call-1", tool: "Bash", decision: "ask" }));
	assert.match(claudeCompletionBlocker(state) ?? "", /permission request/);
});

test("an open call blocks the completion", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("tool.call.opened", { callId: "call-1", tool: "Bash" }));
	assert.match(claudeCompletionBlocker(state) ?? "", /have not settled/);
});

test("an accepted instruction blocks the completion until its cycle", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("command.accepted", { id: "cmd-1", instructionId: "instr-1" }));
	assert.match(claudeCompletionBlocker(state) ?? "", /wait for their cycle/);
});

test("a cycle clears the instruction that it carries", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("command.accepted", { id: "cmd-1", instructionId: "instr-1" }));
	applyObservation(state, observation("turn.start", { turnId: "turn-2", instructionId: "instr-1" }));
	assert.equal(state.pendingInstructions.size, 0);
	/* The turn of the cycle has not ended, so the run waits for its
	   usage. */
	assert.match(claudeCompletionBlocker(state) ?? "", /has not ended/);
});

test("a run that ends its turn can finish", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("turn.start", { turnId: "turn-2" }));
	applyObservation(state, observation("turn.complete", { turnId: "turn-2", usage: null }));
	assert.equal(claudeCompletionBlocker(state), null);
});

test("a cycle without the instruction leaves it pending", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("command.accepted", { id: "cmd-1", instructionId: "instr-1" }));
	applyObservation(state, observation("turn.start", { turnId: "turn-2" }));
	assert.equal(state.pendingInstructions.size, 1);
	assert.match(claudeCompletionBlocker(state) ?? "", /wait for their cycle/);
});

test("the delivery of an instruction clears it", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("command.accepted", { id: "cmd-1", instructionId: "instr-1" }));
	applyObservation(state, observation("instruction.delivered", { uuid: "row-1", instructionId: "instr-1" }));
	assert.equal(state.pendingInstructions.size, 0);
});

test("a report of the current cycle is the bound report", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("turn.start", { turnId: "turn-1" }));
	applyObservation(state, observation("report", { cycleId: "turn-1", state: "completed", result: "DONE" }));
	assert.equal(claudeBoundReport(state)?.result, "DONE");
});

test("a report of an earlier cycle cannot finish newer work", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("turn.start", { turnId: "turn-1" }));
	applyObservation(state, observation("report", { cycleId: "turn-1", state: "completed", result: "OLD" }));
	applyObservation(state, observation("turn.start", { turnId: "turn-2" }));
	assert.equal(claudeBoundReport(state), null);
});

test("every observation counts as activity", () => {
	const state = createClaudeRunState("run-1");
	const before = state.lastActivityAt;
	applyObservation(state, observation("turn.complete", { usage: null }));
	assert.ok(state.lastActivityAt >= before);
});

test("a background settlement counts apart from the foreground call", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("background.settled", { uuid: "row-1" }));
	assert.equal(state.backgroundSettlements, 1);
	assert.equal(state.openCalls.size, 0);
});

test("the measured usage of every turn is kept", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("turn.complete", { usage: { input_tokens: 10, output_tokens: 5 } }));
	applyObservation(state, observation("turn.complete", { usage: { input_tokens: 3, output_tokens: 2 } }));
	assert.equal(state.usage.turns.input, 13);
	assert.equal(state.usage.turns.output, 7);
	assert.equal(state.usage.calls, 2);
});

test("a turn without a usage object keeps the totals partial", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("turn.complete", { usage: null }));
	assert.equal(state.usage.calls, 0);
	assert.equal(state.usage.callsWithoutUsage, 1);
});
