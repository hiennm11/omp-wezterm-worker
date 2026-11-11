import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { acceptanceVerdict, restoreProtectedPaths } from "../tooling/eval/acceptance.ts";
import type { VerifierResult } from "../tooling/eval/types.ts";
import { runVerifier } from "../tooling/eval/verifier.ts";

/** The directories that the tests create. */
const TEMP_DIRS: string[] = [];

/** A temporary directory that the test removes. */
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "eval-acceptance-test-"));
	TEMP_DIRS.push(dir);
	return dir;
}

after(() => {
	for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/** The result of a verifier that exited with a code. */
function verifier(exitCode: number | null, started = true, timedOut = false): VerifierResult {
	return {
		started,
		exitCode,
		timedOut,
		durationMs: 10,
		outputTail: "",
	};
}

/** The evidence of a run that reached the verifier. */
function evidence(result: VerifierResult) {
	return { workerStarted: true, fixtureCopied: true, verifier: result };
}

/** Write a file and create its directory. */
function writeFile(root: string, path: string, text: string): void {
	const full = join(root, path);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, text, "utf8");
}

/** A template fixture with one test file. */
function templateFixture(): string {
	const dir = tempDir();
	writeFile(
		dir,
		"test/pass.test.mjs",
		'import assert from "node:assert/strict";\nimport { test } from "node:test";\n\ntest("it passes", () => {\n\tassert.equal(1, 1);\n});\n',
	);
	return dir;
}

test("the verdict is BLOCKED when the worker did not start", () => {
	const result = acceptanceVerdict({
		workerStarted: false,
		fixtureCopied: true,
		verifier: verifier(0),
	});
	assert.equal(result.verdict, "BLOCKED");
	assert.equal(result.reason, "the worker did not start");
});

test("the verdict is BLOCKED when the fixture copy failed", () => {
	const result = acceptanceVerdict({
		workerStarted: true,
		fixtureCopied: false,
		verifier: verifier(0),
	});
	assert.equal(result.verdict, "BLOCKED");
	assert.equal(result.reason, "the fixture copy failed");
});

test("the verdict is BLOCKED when the verifier did not start", () => {
	const result = acceptanceVerdict(evidence(verifier(null, false)));
	assert.equal(result.verdict, "BLOCKED");
	assert.equal(result.reason, "the verifier did not start");
});

test("the verdict is BLOCKED when the verifier reached its timeout", () => {
	const result = acceptanceVerdict(evidence(verifier(null, true, true)));
	assert.equal(result.verdict, "BLOCKED");
	assert.equal(result.reason, "the verifier reached its timeout");
});

test("the verdict is BLOCKED when the verifier gave no exit code", () => {
	const result = acceptanceVerdict(evidence(verifier(null)));
	assert.equal(result.verdict, "BLOCKED");
	assert.equal(result.reason, "the verifier gave no exit code");
});

test("the verdict is PASS when the verifier exited with code 0", () => {
	const result = acceptanceVerdict(evidence(verifier(0)));
	assert.equal(result.verdict, "PASS");
	assert.equal(result.reason, "");
});

test("the verdict is FAIL when the verifier exited with another code", () => {
	const result = acceptanceVerdict(evidence(verifier(2)));
	assert.equal(result.verdict, "FAIL");
	assert.equal(result.reason, "the verifier exited with code 2");
});

test("a cancelled run with a failing verifier is FAIL", () => {
	const result = acceptanceVerdict(evidence(verifier(1)));
	assert.equal(result.verdict, "FAIL");
	assert.equal(result.reason, "the verifier exited with code 1");
});

test("the restore brings back a file that the run deleted", () => {
	const template = templateFixture();
	const run = tempDir();
	cpSync(template, run, { recursive: true });
	rmSync(join(run, "test/pass.test.mjs"));
	const result = restoreProtectedPaths(template, run, ["test/pass.test.mjs"]);
	assert.deepEqual(result.restored, ["test/pass.test.mjs"]);
	assert.deepEqual(result.missing, []);
	assert.equal(readFileSync(join(run, "test/pass.test.mjs"), "utf8").includes("it passes"), true);
});

test("the restore replaces a weakened test with the template content", () => {
	const template = templateFixture();
	const run = tempDir();
	cpSync(template, run, { recursive: true });
	writeFileSync(join(run, "test/pass.test.mjs"), "// the worker removed the assertion\n", "utf8");
	const result = restoreProtectedPaths(template, run, ["test/pass.test.mjs"]);
	assert.deepEqual(result.restored, ["test/pass.test.mjs"]);
	assert.equal(readFileSync(join(run, "test/pass.test.mjs"), "utf8").includes("it passes"), true);
});

test("the restore brings back every file under a directory", () => {
	const template = templateFixture();
	writeFile(template, "test/other.test.mjs", "export const a = 1;\n");
	const run = tempDir();
	cpSync(template, run, { recursive: true });
	rmSync(join(run, "test"), { recursive: true, force: true });
	const result = restoreProtectedPaths(template, run, ["test"]);
	assert.deepEqual(result.restored, ["test/other.test.mjs", "test/pass.test.mjs"]);
	assert.deepEqual(result.missing, []);
});

test("the restore names a path that the template does not hold", () => {
	const template = templateFixture();
	const run = tempDir();
	const result = restoreProtectedPaths(template, run, ["test/absent.test.mjs"]);
	assert.deepEqual(result.restored, []);
	assert.deepEqual(result.missing, ["test/absent.test.mjs"]);
});

test("a deleted test cannot pass after the restore", () => {
	const template = templateFixture();
	const run = tempDir();
	cpSync(template, run, { recursive: true });
	rmSync(join(run, "test/pass.test.mjs"));
	const command = ["node", "--test", "test/pass.test.mjs"];
	const before = runVerifier(command, run, 60000);
	assert.notEqual(before.exitCode, 0);
	const restored = restoreProtectedPaths(template, run, ["test/pass.test.mjs"]);
	assert.deepEqual(restored.restored, ["test/pass.test.mjs"]);
	const after = runVerifier(command, run, 60000);
	assert.equal(after.exitCode, 0);
});
