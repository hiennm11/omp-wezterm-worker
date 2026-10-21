import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { WorkerReport } from "../extensions/lib/report-model.ts";
import { appendReport, readReports, reportFile } from "../extensions/lib/report-store.ts";

/** A report of one run. */
function report(runId: string, state: WorkerReport["state"], result: string | null = null): WorkerReport {
	return {
		runId,
		state,
		result,
		dependency: null,
		resumeCondition: null,
		needs: null,
		detail: null,
	};
}

test("a report is written and read back", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-store-"));
	try {
		appendReport(dir, report("wz-1", "working"));
		appendReport(dir, report("wz-1", "completed", "the answer"));
		const reports = readReports(dir, "wz-1");
		assert.equal(reports.length, 2);
		assert.equal(reports[1].state, "completed");
		assert.equal(reports[1].result, "the answer");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the reports of two runs stay apart", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-store-"));
	try {
		appendReport(dir, report("wz-1", "completed", "first result"));
		appendReport(dir, report("wz-2", "completed", "second result"));
		const first = readReports(dir, "wz-1");
		assert.equal(first.length, 1);
		assert.equal(first[0].result, "first result");
		const second = readReports(dir, "wz-2");
		assert.equal(second.length, 1);
		assert.equal(second[0].result, "second result");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resumed run does not read the reports of its source run", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-store-"));
	try {
		appendReport(dir, report("wz-1", "completed", "the old answer"));
		const resumed = readReports(dir, "wz-2");
		assert.equal(resumed.length, 0, "the source run reports do not belong to the resumed run");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the report file of a run carries the run id", () => {
	const withRun = reportFile("/state/sessions", "run-a");
	assert.match(withRun, /run-a/);
	const withoutRun = reportFile("/state/sessions");
	assert.doesNotMatch(withoutRun, /run-a/);
});

test("a directory without reports gives an empty list", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-store-"));
	try {
		assert.deepEqual(readReports(dir, "wz-1"), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
