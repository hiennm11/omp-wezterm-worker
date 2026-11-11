/**
 * The check of the testing task.
 *
 * The script runs the new test file against the module of the fixture.
 * The script then runs the test file against a mutated copy of the module.
 * The test must pass on the module and must fail on the mutated copy.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = process.cwd();
const TEST = "test/even.test.mjs";
const MODULE = "src/even.mjs";
const FROM = "value % 2 === 0";
const TO = "value % 2 === 1";

/** Run the test file in a directory and give the exit code. */
function runTest(cwd) {
	const result = spawnSync(process.execPath, ["--test", TEST], {
		cwd,
		encoding: "utf8",
	});
	return result.status;
}

const problems = [];

const original = runTest(FIXTURE);
if (original !== 0) {
	problems.push("the test file does not pass against the module of the repository");
}

const temp = mkdtempSync(join(tmpdir(), "eval-mutation-"));
try {
	const copy = join(temp, "fixture");
	cpSync(FIXTURE, copy, { recursive: true });
	const modulePath = join(copy, MODULE);
	const source = readFileSync(modulePath, "utf8");
	if (!source.includes(FROM)) {
		problems.push("the module does not hold the text that the check mutates");
	} else {
		writeFileSync(modulePath, source.replace(FROM, TO), "utf8");
		const mutated = runTest(copy);
		if (mutated === 0) {
			problems.push("the test file passes against the mutated module");
		}
	}
} finally {
	rmSync(temp, { recursive: true, force: true });
}

if (problems.length > 0) {
	for (const problem of problems) {
		console.error(problem);
	}
	process.exit(1);
}

console.log("The test file passes on the module and fails on the mutated module.");
