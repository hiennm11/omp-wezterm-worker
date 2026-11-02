import assert from "node:assert/strict";
import { test } from "node:test";

import {
	commandLineNamesNoModel,
	descendantsOf,
	homeDifference,
	lastTurnIdOf,
	reportBindsToCycle,
	reportOf,
	runVerdict,
} from "../tooling/claude-smoke-steps.ts";

test("the report of a run is read from the lines of its report file", () => {
	const text = [
		JSON.stringify({ runId: "wz-a-1", cycleId: "turn-1", state: "completed", result: "SMOKE-OK" }),
		JSON.stringify({ runId: "wz-b-2", cycleId: "turn-2", state: "completed", result: "OTHER" }),
	].join("\n");
	const report = reportOf(text, "wz-a-1");
	assert.equal(report?.cycleId, "turn-1");
	assert.equal(report?.result, "SMOKE-OK");
	assert.equal(reportOf(text, "wz-c-3"), null);
});

test("a report binds to the cycle only when the names are equal", () => {
	assert.equal(reportBindsToCycle("turn-1", "turn-1"), true);
	assert.equal(reportBindsToCycle("turn-1", "turn-2"), false);
	assert.equal(reportBindsToCycle(null, "turn-1"), false);
	assert.equal(reportBindsToCycle("turn-1", null), false);
	assert.equal(reportBindsToCycle("", ""), false);
});

test("the last turn of a bridge log is the cycle that the run delivered last", () => {
	const text = [
		JSON.stringify({ source: "turn.start", payload: { turnId: "turn-1" } }),
		JSON.stringify({ source: "tool.call.opened", payload: { callId: "call-1" } }),
		JSON.stringify({ source: "turn.start", payload: { turnId: "turn-2" } }),
		"not json",
	].join("\n");
	assert.equal(lastTurnIdOf(text), "turn-2");
	assert.equal(lastTurnIdOf(""), null);
});

test("a command line that names no model passes the check of the default model", () => {
	assert.equal(commandLineNamesNoModel("claude.EXE --session-id abc --plugin-dir D:\\p"), true);
	assert.equal(commandLineNamesNoModel("claude.EXE --session-id abc --model haiku"), false);
	assert.equal(commandLineNamesNoModel("claude.EXE --session-id abc --model=haiku"), false);
});

test("the difference of the home folder names a change of the settings", () => {
	const same = homeDifference("hash-1", "hash-1", ["a"], ["a", "b"]);
	assert.equal(same.settingsChanged, false);
	assert.deepEqual(same.missingEntries, []);
	assert.deepEqual(same.addedEntries, ["b"]);
});

test("the difference of the home folder names a missing entry", () => {
	const difference = homeDifference("hash-1", "hash-2", ["a", "b"], ["a"]);
	assert.equal(difference.settingsChanged, true);
	assert.deepEqual(difference.missingEntries, ["b"]);
});

test("the verdict of the run fails when a step failed", () => {
	const verdict = runVerdict([
		{ outcome: "pass", what: "one", evidence: "ok" },
		{ outcome: "fail", what: "two", evidence: "no" },
	]);
	assert.equal(verdict.code, 1);
	assert.match(verdict.reason ?? "", /two/);
});

test("the verdict of the run fails when a step could not run", () => {
	const verdict = runVerdict([
		{ outcome: "pass", what: "one", evidence: "ok" },
		{ outcome: "not-run", what: "two", evidence: "no pane" },
	]);
	assert.equal(verdict.code, 1);
	assert.match(verdict.reason ?? "", /two/);
});

test("the verdict of the run gives zero when every step passed", () => {
	const verdict = runVerdict([{ outcome: "pass", what: "one", evidence: "ok" }]);
	assert.equal(verdict.code, 0);
	assert.equal(verdict.reason, null);
});

test("the descendants of a process include every depth below it", () => {
	const rows = [
		{ processId: 1, parentProcessId: null },
		{ processId: 2, parentProcessId: 1 },
		{ processId: 3, parentProcessId: 2 },
		{ processId: 4, parentProcessId: 3 },
		{ processId: 5, parentProcessId: null },
	];
	assert.deepEqual(descendantsOf(rows, [1]).sort(), [2, 3, 4]);
	assert.deepEqual(descendantsOf(rows, [5]), []);
	assert.deepEqual(descendantsOf(rows, []), []);
});

test("the descendants of a process leave the process itself out", () => {
	const rows = [
		{ processId: 1, parentProcessId: null },
		{ processId: 2, parentProcessId: 1 },
	];
	assert.deepEqual(descendantsOf(rows, [2]), []);
});
