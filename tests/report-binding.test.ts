/**
 * The binding of a report to the instruction cycle that produced it.
 *
 * A report of an earlier cycle cannot finish newer work. The owner steers a
 * worker into a new cycle, and the report of the old cycle stays on the
 * disk. The filter keeps that report out of the decision of the new cycle.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readCallLedger } from "../extensions/lib/calls.ts";
import { reportsOfCycle } from "../extensions/lib/report-binding.ts";
import { decideFromReports } from "../extensions/lib/report-decision.ts";
import type { WorkerReport } from "../extensions/lib/report-model.ts";

/** The time of the user message that starts the first cycle. */
const FIRST_CYCLE = 1_000_000;

/** The time of the user message that starts the second cycle. */
const SECOND_CYCLE = 2_000_000;

/** Write a transcript that holds the given lines. */
function writeTranscript(dir: string, lines: unknown[]): string {
	const file = join(dir, "a.jsonl");
	writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
	return file;
}

/** A report of one state, written at the given time. */
function report(state: WorkerReport["state"], at: number, result: string | null = null): WorkerReport {
	return {
		runId: "run-1",
		state,
		result,
		dependency: null,
		resumeCondition: null,
		needs: null,
		detail: null,
		at,
	};
}

/** A transcript with one cycle that starts at the given time. */
function cycleAt(dir: string, at: number | undefined): string {
	const user: Record<string, unknown> = {
		type: "message",
		id: "e0",
		message: { role: "user", content: [{ type: "text", text: "do it" }] },
	};
	if (at !== undefined) user.timestamp = at;
	return writeTranscript(dir, [
		user,
		{
			type: "message",
			id: "e1",
			message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
		},
	]);
}

test("a report of an earlier cycle is out of the cycle", () => {
	const reports = [report("completed", FIRST_CYCLE, "THE-ANSWER")];
	assert.deepEqual(reportsOfCycle(reports, SECOND_CYCLE), []);
});

test("a report of the current cycle is in the cycle", () => {
	const reports = [report("completed", SECOND_CYCLE, "THE-ANSWER")];
	assert.equal(reportsOfCycle(reports, SECOND_CYCLE).length, 1);
});

test("a cycle without a start time keeps every report", () => {
	const reports = [report("completed", FIRST_CYCLE, "THE-ANSWER")];
	assert.equal(reportsOfCycle(reports, null).length, 1);
});

test("a report without a write time stays in the cycle", () => {
	const reports: WorkerReport[] = [
		{
			runId: "run-1",
			state: "completed",
			result: "THE-ANSWER",
			dependency: null,
			resumeCondition: null,
			needs: null,
			detail: null,
		},
	];
	assert.equal(reportsOfCycle(reports, SECOND_CYCLE).length, 1);
});

test("a completed report of an earlier cycle does not complete the run", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-binding-"));
	try {
		const ledger = readCallLedger(cycleAt(dir, SECOND_CYCLE));
		const reports = [report("completed", FIRST_CYCLE, "THE-ANSWER")];
		const decision = decideFromReports(ledger, reportsOfCycle(reports, ledger.lastUserEntryAt));
		assert.equal(decision.state, "unknown", "the old report proves nothing");
		assert.equal(decision.condition, "missing_report", "the new cycle needs a report");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a completed report of the current cycle completes the run", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-binding-"));
	try {
		const ledger = readCallLedger(cycleAt(dir, SECOND_CYCLE));
		const reports = [report("completed", SECOND_CYCLE, "THE-ANSWER")];
		const decision = decideFromReports(ledger, reportsOfCycle(reports, ledger.lastUserEntryAt));
		assert.equal(decision.state, "completed");
		assert.equal(decision.result, "THE-ANSWER");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a user entry without a timestamp keeps the report of the cycle", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-binding-"));
	try {
		const ledger = readCallLedger(cycleAt(dir, undefined));
		const reports = [report("completed", FIRST_CYCLE, "THE-ANSWER")];
		const decision = decideFromReports(ledger, reportsOfCycle(reports, ledger.lastUserEntryAt));
		assert.equal(decision.state, "completed", "no evidence of a cycle start");
		assert.equal(decision.result, "THE-ANSWER");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
