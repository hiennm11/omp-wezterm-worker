import assert from "node:assert/strict";
import { test } from "node:test";

import { backendRefusal, readBackend } from "../extensions/lib/backend.ts";
import { boundReport, reportsOfCycle } from "../extensions/lib/report-binding.ts";
import type { WorkerReport } from "../extensions/lib/report-model.ts";

/** A report of one state, with an optional cycle. */
function report(
	state: WorkerReport["state"],
	cycleId?: string | null,
	result: string | null = null,
): WorkerReport {
	return {
		runId: "run-1",
		cycleId: cycleId ?? null,
		state,
		result,
		dependency: null,
		resumeCondition: null,
		needs: null,
		detail: null,
	};
}

test("a run without a backend field is an OMP run", () => {
	assert.equal(readBackend({}), "omp");
	assert.equal(readBackend({ backend: "claude" }), "claude");
});

test("a run with an unknown backend field is an OMP run", () => {
	assert.equal(readBackend({ backend: "something-else" }), "omp");
});

test("a backend that is not implemented is refused", () => {
	assert.match(backendRefusal("codex") ?? "", /not implemented/);
	assert.match(backendRefusal("codex") ?? "", /never falls back/);
});

test("an implemented backend has no refusal", () => {
	assert.equal(backendRefusal("omp"), null);
	assert.equal(backendRefusal("claude"), null);
});

test("a report of the current cycle is the bound report", () => {
	const reports = [report("working", "cycle-1"), report("completed", "cycle-2", "DONE")];
	assert.equal(boundReport(reports, "cycle-2")?.result, "DONE");
});

test("a report of an earlier cycle cannot finish newer work", () => {
	const reports = [report("completed", "cycle-1", "OLD")];
	assert.equal(boundReport(reports, "cycle-2"), null);
});

test("a report without a cycle needs a run with one cycle", () => {
	assert.equal(boundReport([report("completed", null, "ANY")], "cycle-2"), null);
	assert.equal(boundReport([report("completed", null, "ANY")], null)?.result, "ANY");
});

test("the reports of a cycle leave the reports of other cycles out", () => {
	const reports = [report("working", "cycle-1"), report("completed", "cycle-2", "DONE")];
	assert.equal(reportsOfCycle(reports, "cycle-2").length, 1);
	assert.equal(reportsOfCycle(reports, "cycle-1").length, 1);
});
