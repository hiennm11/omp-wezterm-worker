/**
 * The usage of a restored native run.
 *
 * A restart cuts the counts of a native run. The new owner counts from the
 * restart, so the usage of a restored run is partial and says so.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createClaudeRunState } from "../extensions/lib/claude-run-state.ts";
import { addNativeUsage } from "../extensions/lib/native-usage.ts";
import { nativeUsageReport } from "../extensions/lib/native-usage-report.ts";
import { reattachNative } from "../extensions/lib/reattach-native.ts";
import { cleanup, fakeRuntime, makeDirs, nativeJob } from "./reattach-native-helpers.ts";

const TURN = { input_tokens: 10, output_tokens: 5 };

test("reattachNative marks the usage of the run with the time of the restart", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, [7]);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		const before = Date.now();
		await reattachNative(rt, job);
		const restoredAt = rt.claudeStates.get(job.id)?.usage.restoredAt;
		assert.equal(typeof restoredAt, "number", "the usage holds the time of the restart");
		assert.ok((restoredAt as number) >= before, "the time is the time of this restart");
		assert.equal(createClaudeRunState("r").usage.restoredAt, undefined, "a new run has no mark");
	} finally {
		await cleanup(rt, dir);
	}
});

test("a restored run with one measured turn has a partial usage with the reason", () => {
	const state = createClaudeRunState("r");
	addNativeUsage(state.usage, TURN);
	state.usage.restoredAt = Date.now();
	const report = nativeUsageReport(state);
	assert.equal(report.state, "partial");
	assert.match(report.note ?? "", /counted from the restart of OMP/);
});

test("a run that never restarted keeps a measured usage", () => {
	const state = createClaudeRunState("r");
	addNativeUsage(state.usage, TURN);
	assert.equal(nativeUsageReport(state).state, "measured");
});

test("a restored run without a measured turn stays unknown", () => {
	const state = createClaudeRunState("r");
	state.usage.restoredAt = Date.now();
	assert.equal(nativeUsageReport(state).state, "unknown");
});

test("a restored run with a turn without usage keeps both reasons", () => {
	const state = createClaudeRunState("r");
	addNativeUsage(state.usage, TURN);
	addNativeUsage(state.usage, null);
	state.usage.restoredAt = Date.now();
	const report = nativeUsageReport(state);
	assert.equal(report.state, "partial");
	assert.match(report.note ?? "", /counted from the restart of OMP/);
	assert.match(report.note ?? "", /have no usage data/);
});
