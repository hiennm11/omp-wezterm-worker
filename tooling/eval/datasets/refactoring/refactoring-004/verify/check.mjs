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

const test = spawnSync(process.execPath, ["--test", "test/port.test.mjs"], {
	cwd: FIXTURE,
	encoding: "utf8",
});
if (test.status !== 0) {
	problems.push("the test file fails");
}

if (!read("src/port.mjs").includes("export function isValidPort(")) {
	problems.push("the module src/port.mjs does not export the function isValidPort");
}
const calls = read("src/port.mjs").match(/\bisValidPort\(/g) ?? [];
if (calls.length < 2) {
	problems.push("the function parsePort does not call the function isValidPort");
}

if (problems.length > 0) {
	for (const problem of problems) {
		console.error(problem);
	}
	process.exit(1);
}

console.log("The test passes and the structure is correct.");
