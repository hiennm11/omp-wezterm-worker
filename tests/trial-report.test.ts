/**
 * The text of the Windows trial report.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { usageReport } from "../extensions/lib/usage.ts";
import {
	renderTrialReport,
	type ScenarioResult,
	type TrialRun,
	trialPassed,
} from "../tooling/trial-report.ts";

/** A run with one scenario and the given checks. */
function runWith(checks: ScenarioResult["checks"]): TrialRun {
	const scenario: ScenarioResult = {
		name: "Survey",
		task: "Read every file under src/.",
		workerId: "wz-1",
		status: "completed",
		workerMs: 1500,
		wallMs: 2000,
		usage: usageReport(null, "the worker did not start"),
		transcript: "C:/tmp/sessions/wz-1",
		checks,
	};
	return {
		startedAt: "2026-10-20T10:00:00.000Z",
		environment: { os: "Windows_NT 10.0.26300", node: "v22.18.0", omp: "omp/18.12.3", wezterm: "wezterm 1" },
		model: "omniroute/minimax/MiniMax-M3.1-Flash",
		stateDir: "C:/tmp/state",
		roots: [{ absolute: "C:/tmp/state", label: "<trial state>" }],
		scenarios: [scenario],
	};
}

test("a run with a failing check does not pass", () => {
	const run = runWith([{ name: "the worker completed", pass: false, detail: "the status was failed" }]);
	assert.equal(trialPassed(run), false);
});

test("the report names the unknown usage and the failing check", () => {
	const run = runWith([{ name: "the worker completed", pass: false, detail: "the status was failed" }]);
	const text = renderTrialReport(run);
	assert.match(text, /unknown \(the worker did not start\)/);
	assert.match(text, /- FAIL: the worker completed\. the status was failed/);
});

test("a run with all checks passing passes and shows the count", () => {
	const run = runWith([
		{ name: "the worker completed", pass: true, detail: "the status was completed" },
		{ name: "the answer names both functions", pass: true, detail: "the answer names add and subtract" },
	]);
	assert.equal(trialPassed(run), true);
	const text = renderTrialReport(run);
	assert.match(text, /\| Survey \| completed \| 2 s \| 2 s \|/);
	assert.match(text, /\| 2\/2 \|/);
});

test("the report holds the task, the worker and the transcript", () => {
	const run = runWith([]);
	const text = renderTrialReport(run);
	assert.match(text, /Worker: wz-1\./);
	// The transcript is outside the project, so the report names no path of it.
	assert.match(text, /Transcript: <outside the project>\./);
	assert.match(text, /Read every file under src\/\./);
});

test("a detail with a line break stays on one line", () => {
	const run = runWith([{ name: "the result was delivered", pass: true, detail: "the answer\non two lines" }]);
	const text = renderTrialReport(run);
	assert.match(text, /- PASS: the result was delivered\. the answer on two lines/);
});

test("a detail with a path of the machine holds no name of the user", () => {
	const run = runWith([
		{
			name: "the result was delivered",
			pass: true,
			detail: "the worker worked in C:\\Users\\someone\\AppData\\Local\\Temp\\fixture-1",
		},
	]);
	const text = renderTrialReport(run);
	assert.doesNotMatch(text, /someone/);
	assert.match(text, /<home>/);
});

test("a detail with a root of the trial holds no path of the machine", () => {
	const run = runWith([
		{
			name: "the result was delivered",
			pass: true,
			detail: "the worker worked in C:/tmp/state/sessions/wz-1",
		},
	]);
	const text = renderTrialReport(run);
	assert.doesNotMatch(text, /C:\/tmp\/state/);
	assert.match(text, /<trial state>/);
});

test("the report holds no path of the machine", () => {
	const run = runWith([
		{ name: "the result was delivered", pass: true, detail: "cwd: C:\\Users\\someone\\work" },
	]);
	const text = renderTrialReport(run);
	assert.doesNotMatch(text, /[A-Za-z]:\\Users\\[a-z]/i);
});
