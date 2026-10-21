/**
 * The paths of the Windows trial.
 *
 * The report is a public document, so it must hold no path of the machine
 * that ran the trial.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { OUTSIDE, PROJECT_ROOT, redactHome, replaceRoots, reportPath } from "../tooling/trial-paths.ts";

test("a path under the project becomes a relative path", () => {
	assert.equal(reportPath(join(PROJECT_ROOT, "docs", "trials")), "docs/trials");
});

test("the project root becomes a dot", () => {
	assert.equal(reportPath(PROJECT_ROOT), ".");
});

test("a path outside the project becomes the placeholder", () => {
	assert.equal(reportPath("C:/tmp/state"), OUTSIDE);
});

test("a path on another drive is outside the project", () => {
	// `path.relative` gives an absolute path for another drive, so the
	// check must catch that case and not only the `..` case.
	assert.equal(reportPath("Z:/elsewhere/state"), OUTSIDE);
});

test("a path above the project is outside the project", () => {
	assert.equal(reportPath(join(PROJECT_ROOT, "..", "..", "other")), OUTSIDE);
});

test("the home directory becomes a placeholder", () => {
	const text = "the worker worked in C:\\Users\\someone\\AppData\\Local\\Temp";
	assert.doesNotMatch(redactHome(text), /someone/);
	assert.match(redactHome(text), /<home>/);
});

test("a POSIX home directory becomes a placeholder", () => {
	assert.doesNotMatch(redactHome("the worker worked in /home/someone/work"), /someone/);
});

test("a root of the trial becomes its label", () => {
	const text = "the worker worked in C:/tmp/state/sessions/wz-1";
	const result = replaceRoots(text, [{ absolute: "C:/tmp/state", label: "<trial state>" }]);
	assert.equal(result, "the worker worked in <trial state>/sessions/wz-1");
});

test("a root of the trial is found with either separator", () => {
	const text = "the worker worked in C:\\tmp\\state\\sessions\\wz-1";
	const result = replaceRoots(text, [{ absolute: "C:/tmp/state", label: "<trial state>" }]);
	assert.equal(result, "the worker worked in <trial state>/sessions/wz-1");
});

test("the longest root comes first", () => {
	const text = "the worker worked in C:/tmp/state/worktrees/wz-1";
	const result = replaceRoots(text, [
		{ absolute: "C:/tmp/state", label: "<trial state>" },
		{ absolute: "C:/tmp/state/worktrees", label: "<worktrees>" },
	]);
	assert.equal(result, "the worker worked in <worktrees>/wz-1");
});
