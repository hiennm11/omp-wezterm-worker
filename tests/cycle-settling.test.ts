import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readCallLedger } from "../extensions/lib/calls.ts";
import { CYCLE_SETTLE_MS, needsIntervention, readCycleState } from "../extensions/lib/cycle-state.ts";
import { decideFromReports } from "../extensions/lib/report-decision.ts";

/** Write a transcript that holds the given lines. */
function writeTranscript(dir: string, lines: unknown[]): string {
	const file = join(dir, "a.jsonl");
	writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
	return file;
}

/** A transcript with one closed cycle. */
function closedCycle(dir: string): string {
	return writeTranscript(dir, [
		{ type: "message", id: "e0", message: { role: "user", content: [{ type: "text", text: "do it" }] } },
		{ type: "message", id: "e1", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
	]);
}

test("a cycle that just closed does not need an intervention yet", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-settle-"));
	try {
		const ledger = readCallLedger(closedCycle(dir));
		const state = readCycleState(ledger, null, 1000);
		assert.equal(state.closed, true);
		assert.equal(needsIntervention(state, false, 1000), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a cycle that holds for the settling time needs an intervention", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-settle-"));
	try {
		const ledger = readCallLedger(closedCycle(dir));
		const state = readCycleState(ledger, null, 1000);
		assert.equal(needsIntervention(state, false, 1000 + CYCLE_SETTLE_MS), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a cycle with a report needs no intervention", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-settle-"));
	try {
		const ledger = readCallLedger(closedCycle(dir));
		const state = readCycleState(ledger, null, 1000);
		assert.equal(needsIntervention(state, true, 1000 + CYCLE_SETTLE_MS), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an open tool call keeps the cycle open", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-settle-"));
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
		const state = readCycleState(ledger, null, 1000);
		assert.equal(state.closed, false);
		assert.equal(needsIntervention(state, false, 1000 + CYCLE_SETTLE_MS), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a new cycle restarts the settling time", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-settle-"));
	try {
		const first = readCycleState(readCallLedger(closedCycle(dir)), null, 1000);
		assert.equal(needsIntervention(first, false, 1000 + CYCLE_SETTLE_MS), true);
		// A new user message starts a new cycle. The settling time restarts.
		const next = writeTranscript(dir, [
			{ type: "message", id: "e0", message: { role: "user", content: [{ type: "text", text: "do it" }] } },
			{
				type: "message",
				id: "e1",
				message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
			},
			{ type: "message", id: "e2", message: { role: "user", content: [{ type: "text", text: "more" }] } },
			{
				type: "message",
				id: "e3",
				message: { role: "assistant", content: [{ type: "text", text: "Done again." }] },
			},
		]);
		const second = readCycleState(readCallLedger(next), first, 2000);
		assert.equal(second.evidenceId, "e2");
		assert.equal(second.closedSince, 2000);
		assert.equal(needsIntervention(second, false, 2000 + CYCLE_SETTLE_MS - 1), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * A transcript that ends with the result of a tool call.
 *
 * The shape is the shape of a real worker transcript. The assistant message
 * holds a thinking block and a tool call. The result of that call is the
 * last entry. The model thinks after the result.
 */
function thinkingAfterToolResult(dir: string): string {
	return writeTranscript(dir, [
		{ type: "message", id: "e0", message: { role: "user", content: [{ type: "text", text: "do it" }] } },
		{
			type: "message",
			id: "e1",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "I read the file." },
					{ type: "toolCall", id: "call-1", name: "read" },
				],
			},
		},
		{
			type: "message",
			id: "e2",
			message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "file" }] },
		},
	]);
}

test("a tool result at the end of a transcript keeps the cycle open", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-settle-"));
	try {
		const ledger = readCallLedger(thinkingAfterToolResult(dir));
		const state = readCycleState(ledger, null, 1000);
		assert.equal(state.closed, false, "the model still thinks after the tool result");
		assert.equal(needsIntervention(state, false, 1000 + CYCLE_SETTLE_MS), false);
		assert.equal(decideFromReports(ledger, []).condition, null, "no event while the model thinks");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an assistant message that holds a tool call keeps the cycle open", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-settle-"));
	try {
		const file = writeTranscript(dir, [
			{ type: "message", id: "e0", message: { role: "user", content: [{ type: "text", text: "do it" }] } },
			{
				type: "message",
				id: "e1",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "I read the file." },
						{ type: "toolCall", id: "call-1", name: "read" },
					],
				},
			},
		]);
		const ledger = readCallLedger(file);
		const state = readCycleState(ledger, null, 1000);
		assert.equal(state.closed, false, "the turn does not end at a tool call");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a text-only assistant message at the end of a transcript closes the cycle", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-settle-"));
	try {
		const ledger = readCallLedger(closedCycle(dir));
		const state = readCycleState(ledger, null, 1000);
		assert.equal(state.closed, true);
		assert.equal(needsIntervention(state, false, 1000 + CYCLE_SETTLE_MS), true);
		assert.equal(decideFromReports(ledger, []).condition, "missing_report", "the event comes");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
