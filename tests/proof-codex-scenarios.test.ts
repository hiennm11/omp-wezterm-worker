import assert from "node:assert/strict";
import { test } from "node:test";

import * as codexLifecycle from "../tooling/backend-proof/codex-lifecycle.ts";
import * as codexQueue from "../tooling/backend-proof/codex-queue.ts";
import * as codexRun from "../tooling/backend-proof/codex-run.ts";

test("the task of the queue scenario keeps the turn busy", () => {
	const text = codexQueue.queueTaskText();
	assert.ok(text.includes("20 seconds"), text);
	assert.ok(text.includes("shell command"), text);
});

test("the queue scenario sends its instruction with a client id", () => {
	const params = codexQueue.queueSteerParams("thread-1", "turn-1", "client-1");
	assert.equal(params.threadId, "thread-1");
	assert.equal(params.expectedTurnId, "turn-1");
	assert.equal(params.clientUserMessageId, "client-1");
	assert.equal(params.input.length, 1);
});

test("the queue scenario counts a delivered instruction by its client id", () => {
	const observations = [
		{ source: "codex.item/started", payload: { item: { type: "userMessage", clientId: "other" } } },
		{ source: "codex.item/started", payload: { item: { type: "userMessage", clientId: "client-1" } } },
		{ source: "codex.item/started", payload: { item: { type: "commandExecution" } } },
	];
	assert.equal(codexQueue.deliveredInstructionCount(observations, "client-1"), 1);
});

test("the queue scenario passes when an accepted entry became a delivered input", () => {
	const verdict = codexQueue.queueVerdict({ accepted: true, refusal: null, delivered: 1 });
	assert.equal(verdict.verdict, "pass");
});

test("the queue scenario fails when the native program refused the instruction", () => {
	const verdict = codexQueue.queueVerdict({
		accepted: false,
		refusal: "no active turn to steer",
		delivered: 0,
	});
	assert.equal(verdict.verdict, "fail");
	assert.ok(verdict.detail.includes("no active turn to steer"), verdict.detail);
});

test("the queue scenario fails when the accepted entry never reached the model", () => {
	const verdict = codexQueue.queueVerdict({ accepted: true, refusal: null, delivered: 0 });
	assert.equal(verdict.verdict, "fail");
	assert.ok(verdict.detail.includes("never reached"), verdict.detail);
});

test("the task of the no-report scenario forbids a tool", () => {
	const text = codexRun.noReportTaskText();
	assert.ok(text.includes("DONE"), text);
	assert.ok(text.includes("Do not call any tool."), text);
});

test("the no-report scenario fails when a report arrived", () => {
	const verdict = codexRun.noReportVerdict(1, 1);
	assert.equal(verdict.verdict, "fail");
	assert.ok(verdict.detail.includes("report"), verdict.detail);
});

test("the no-report scenario passes when a turn ended and no report arrived", () => {
	const verdict = codexRun.noReportVerdict(0, 1);
	assert.equal(verdict.verdict, "pass");
});

test("the no-report scenario stays unavailable when the turn never ended", () => {
	const verdict = codexRun.noReportVerdict(0, 0);
	assert.equal(verdict.verdict, "unavailable");
});

test("the approval scenario pins a policy that asks the person", () => {
	const params = codexLifecycle.approvalTurnParams("thread-1");
	assert.equal(params.approvalPolicy, "untrusted");
	assert.equal(params.threadId, "thread-1");
});
