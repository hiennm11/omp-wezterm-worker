import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readCallLedger } from "../extensions/lib/calls.ts";
import { completionBlocker, decideFromReports, reportState } from "../extensions/lib/report-decision.ts";
import type { WorkerReport } from "../extensions/lib/report-model.ts";

/** Write a transcript that holds the given lines. */
function writeTranscript(dir: string, lines: unknown[]): string {
	const file = join(dir, "a.jsonl");
	writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
	return file;
}

/** A report of one state. */
function report(state: WorkerReport["state"], result: string | null = null): WorkerReport {
	return {
		runId: "run-1",
		state,
		result,
		dependency: null,
		resumeCondition: null,
		needs: null,
		detail: null,
	};
}

test("a completed report proves the completion and its result", () => {
	const { state, result } = reportState([report("working"), report("completed", "the answer")]);
	assert.equal(state, "completed");
	assert.equal(result, "the answer");
});

test("a working report after a completion clears the result", () => {
	const { state, result } = reportState([report("completed", "the answer"), report("working")]);
	assert.equal(state, "working");
	assert.equal(result, null);
});

test("no report leaves the state unknown", () => {
	const { state } = reportState([]);
	assert.equal(state, "unknown");
});

test("a cycle with a report needs no intervention", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-decision-"));
	try {
		const file = writeTranscript(dir, [
			{ type: "message", id: "e0", message: { role: "user", content: [{ type: "text", text: "do it" }] } },
			{
				type: "message",
				id: "e1",
				message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
			},
		]);
		const ledger = readCallLedger(file);
		const decision = decideFromReports(ledger, [report("completed", "the answer")]);
		assert.equal(decision.condition, null, "the report satisfies the rule");
		assert.equal(decision.state, "completed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a cycle without a report needs an intervention", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-decision-"));
	try {
		const file = writeTranscript(dir, [
			{ type: "message", id: "e0", message: { role: "user", content: [{ type: "text", text: "do it" }] } },
			{
				type: "message",
				id: "e1",
				message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
			},
		]);
		const ledger = readCallLedger(file);
		const decision = decideFromReports(ledger, []);
		assert.equal(decision.condition, "missing_report");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a working report followed by an idle worker is a separate condition", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-decision-"));
	try {
		const file = writeTranscript(dir, [
			{ type: "message", id: "e0", message: { role: "user", content: [{ type: "text", text: "do it" }] } },
			{
				type: "message",
				id: "e1",
				message: { role: "assistant", content: [{ type: "text", text: "Working." }] },
			},
		]);
		const ledger = readCallLedger(file);
		const decision = decideFromReports(ledger, [report("working")]);
		assert.equal(decision.condition, "idle_after_working");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an open tool call leaves the worker working", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-decision-"));
	try {
		const file = writeTranscript(dir, [
			{ type: "message", id: "e0", message: { role: "user", content: [{ type: "text", text: "do it" }] } },
			{
				type: "message",
				id: "e1",
				message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash" }] },
			},
		]);
		const ledger = readCallLedger(file);
		const decision = decideFromReports(ledger, []);
		assert.equal(decision.condition, null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unknown execution blocks a completion", () => {
	assert.match(completionBlocker(0, 1) ?? "", /no settlement evidence/);
});

test("an outstanding execution blocks a completion", () => {
	assert.match(completionBlocker(2, 0) ?? "", /still outstanding/);
});

test("no outstanding execution leaves a completion free", () => {
	assert.equal(completionBlocker(0, 0), null);
});
