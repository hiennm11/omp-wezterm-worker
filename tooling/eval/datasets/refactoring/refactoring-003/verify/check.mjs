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

const test = spawnSync(process.execPath, ["--test", "test/strings.test.mjs"], {
	cwd: FIXTURE,
	encoding: "utf8",
});
if (test.status !== 0) {
	problems.push("the test file fails");
}

if (!exists("src/title-case.mjs")) {
	problems.push("the module src/title-case.mjs does not exist");
} else if (!read("src/title-case.mjs").includes("export function titleCase(")) {
	problems.push("the module src/title-case.mjs does not export the function titleCase");
}
if (read("src/strings.mjs").includes("function titleCase")) {
	problems.push("the module src/strings.mjs still defines the function titleCase");
}
if (!read("src/report.mjs").includes("title-case.mjs")) {
	problems.push("the module src/report.mjs does not import the new module");
}
if (read("src/report.mjs").includes("from \"./strings.mjs\"")) {
	problems.push("the module src/report.mjs still imports the module src/strings.mjs");
}

if (problems.length > 0) {
	for (const problem of problems) {
		console.error(problem);
	}
	process.exit(1);
}

console.log("The test passes and the structure is correct.");
