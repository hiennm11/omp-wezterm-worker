import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readCallLedger } from "../extensions/lib/calls.ts";
import { cycleEnd, cycleEvidenceId, missingReportCondition } from "../extensions/lib/cycle.ts";

/** Write a transcript that holds the given lines. */
function writeTranscript(dir: string, lines: unknown[]): string {
	const file = join(dir, "a.jsonl");
	writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
	return file;
}

/** A user message that starts a cycle. */
const USER = {
	type: "message",
	id: "e0",
	message: { role: "user", content: [{ type: "text", text: "do it" }] },
};

test("a completed report followed by ordinary text creates no event", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-cycle-"));
	try {
		const file = writeTranscript(dir, [
			USER,
			{
				type: "message",
				id: "e1",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "wezterm_worker_report" }],
				},
			},
			{
				type: "message",
				id: "e2",
				message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] },
			},
			{
				type: "message",
				id: "e3",
				message: { role: "assistant", content: [{ type: "text", text: "All done." }] },
			},
		]);
		const ledger = readCallLedger(file);
		// The cycle held a report, so the rule is satisfied.
		assert.equal(missingReportCondition(ledger, true), null);
		assert.equal(cycleEnd(ledger).kind, "terminal");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a cycle without a report needs an intervention", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-cycle-"));
	try {
		const file = writeTranscript(dir, [
			USER,
			{
				type: "message",
				id: "e1",
				message: { role: "assistant", content: [{ type: "text", text: "I am thinking about it." }] },
			},
		]);
		const ledger = readCallLedger(file);
		assert.equal(missingReportCondition(ledger, false), "missing_report");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an open tool call does not close the cycle", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-cycle-"));
	try {
		const file = writeTranscript(dir, [
			USER,
			{
				type: "message",
				id: "e1",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "bash" }],
				},
			},
		]);
		const ledger = readCallLedger(file);
		const end = cycleEnd(ledger);
		assert.equal(end.kind, "open");
		assert.equal(missingReportCondition(ledger, false), null, "the worker is still working");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the evidence id of a cycle names its start", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-cycle-"));
	try {
		const file = writeTranscript(dir, [USER]);
		const ledger = readCallLedger(file);
		assert.equal(cycleEvidenceId(ledger), "e0");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a second cycle has its own evidence id", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-cycle-"));
	try {
		const file = writeTranscript(dir, [
			USER,
			{ type: "message", id: "e1", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
			{ type: "message", id: "e2", message: { role: "user", content: [{ type: "text", text: "more" }] } },
		]);
		const ledger = readCallLedger(file);
		assert.equal(cycleEvidenceId(ledger), "e2");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
