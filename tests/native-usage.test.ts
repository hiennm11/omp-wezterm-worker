import assert from "node:assert/strict";
import { test } from "node:test";

import { formatDelivery } from "../extensions/lib/deliver.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { addNativeUsage, emptyNativeTotals, nativeUsageTotals } from "../extensions/lib/native-usage.ts";
import { nativeUsageReport, requestUsageOf } from "../extensions/lib/native-usage-report.ts";

test("the usage of a turn joins the totals of the run", () => {
	const totals = emptyNativeTotals();
	addNativeUsage(totals, { input_tokens: 100, output_tokens: 20, model: "claude-haiku-4" });
	addNativeUsage(totals, { input_tokens: 50, output_tokens: 10 });
	assert.equal(totals.calls, 2);
	assert.equal(totals.turns.input, 150);
	assert.equal(totals.turns.output, 30);
	assert.equal(totals.model, "claude-haiku-4");
});

test("the cache counts of a turn are measured", () => {
	const totals = emptyNativeTotals();
	addNativeUsage(totals, {
		input_tokens: 10,
		output_tokens: 5,
		cache_read_input_tokens: 900,
		cache_creation_input_tokens: 40,
	});
	assert.equal(totals.turns.cacheRead, 900);
	assert.equal(totals.turns.cacheWrite, 40);
	assert.equal(totals.turns.total, 955);
});

test("a turn without a usage object keeps the totals partial", () => {
	const totals = emptyNativeTotals();
	addNativeUsage(totals, null);
	assert.equal(totals.calls, 0);
	assert.equal(totals.callsWithoutUsage, 1);
	assert.equal(totals.turns.input, 0);
});

test("a native report of a run without usage is unknown", () => {
	const report = nativeUsageReport(null);
	assert.equal(report.state, "unknown");
});

test("a native report of a measured run is measured", () => {
	const totals = emptyNativeTotals();
	addNativeUsage(totals, { input_tokens: 10, output_tokens: 2 });
	const report = nativeUsageReport({ usage: { ...totals } });
	assert.equal(report.state, "measured");
});

test("a native report of a run with a gap is partial", () => {
	const totals = emptyNativeTotals();
	addNativeUsage(totals, { input_tokens: 10 });
	addNativeUsage(totals, null);
	const report = nativeUsageReport({ usage: { ...totals } });
	assert.equal(report.state, "partial");
});

test("a native report of a run whose turns have no usage is unknown", () => {
	const totals = emptyNativeTotals();
	addNativeUsage(totals, null);
	const report = nativeUsageReport({ usage: { ...totals } });
	assert.equal(report.state, "unknown");
});

test("a native run has no side calls and no cost", () => {
	const totals = emptyNativeTotals();
	addNativeUsage(totals, { input_tokens: 10, output_tokens: 2 });
	const converted = nativeUsageTotals(totals);
	assert.equal(converted.sideCalls.total, 0);
	assert.equal(converted.cost, 0);
	assert.equal(converted.turns.total, 12);
});

test("a fresh run holds no native usage", () => {
	const state = freshRunState(0);
	assert.equal(state.nativeUsage, null);
});

test("a fresh run resets the native usage of its source", () => {
	const source = { ...freshRunState(0), nativeUsage: emptyNativeTotals() };
	const resumed = { ...source, ...freshRunState(1) };
	assert.equal(resumed.nativeUsage, null);
});

/** A native job that has started. */
function nativeJob(): Job {
	return {
		id: "wz-1",
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir: "/s/wz-1",
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(0),
		startedAt: 1,
		backend: "claude",
	};
}

test("the delivery of a native run names its turn count", () => {
	const job = { ...freshRunState(0), id: "wz-1", label: "test", turns: 0 };
	const text = formatDelivery(
		job as never,
		{
			worker: { state: "measured", totals: null, cost: null, note: "" },
			request: { state: "unknown", totals: null, cost: null, note: "" },
		},
		3,
	);
	assert.match(text, /turns: 3/);
});

test("the usage of a request counts a native worker", () => {
	const totals = emptyNativeTotals();
	addNativeUsage(totals, { input_tokens: 40, output_tokens: 8 });
	const jobs = new Map([["wz-1", { ...nativeJob(), nativeUsage: totals }]]);
	const report = requestUsageOf(jobs, ["wz-1"], new Map());
	assert.equal(report.state, "measured");
	assert.equal(report.totals?.turns.input, 40);
});

test("the usage of a request without a native worker is unknown", () => {
	const jobs = new Map([["wz-1", nativeJob()]]);
	const report = requestUsageOf(jobs, ["wz-1"], new Map());
	assert.equal(report.state, "unknown");
});
