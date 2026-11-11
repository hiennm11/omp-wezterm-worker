/**
 * The check of the refactoring task.
 *
 * The script runs the test file and the structural checks of the task.
 * The script fails when the test fails or when a structural check fails.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE = process.cwd();

/** The text of a file of the fixture. */
function read(relativePath) {
	return readFileSync(join(FIXTURE, relativePath), "utf8");
}

/** The fact that a file of the fixture exists. */
function exists(relativePath) {
	return existsSync(join(FIXTURE, relativePath));
}

const problems = [];

const test = spawnSync(process.execPath, ["--test", "test/label.test.mjs"], {
	cwd: FIXTURE,
	encoding: "utf8",
});
if (test.status !== 0) {
	problems.push("the test file fails");
}

if (!read("src/text.mjs").includes("export function uppercase(")) {
	problems.push("the module src/text.mjs does not export the function uppercase");
}
if (/\btoUpper\b/.test(read("src/text.mjs"))) {
	problems.push("the module src/text.mjs still names the function toUpper");
}
if (!/\buppercase\b/.test(read("src/label.mjs"))) {
	problems.push("the module src/label.mjs does not import the function uppercase");
}
if (/\btoUpper\b/.test(read("src/label.mjs"))) {
	problems.push("the module src/label.mjs still names the function toUpper");
}

if (problems.length > 0) {
	for (const problem of problems) {
		console.error(problem);
	}
	process.exit(1);
}

console.log("The test passes and the structure is correct.");
