/**
 * The repository that the trial workers work in.
 *
 * The fixture holds one module and one test file. The test for `subtract`
 * fails, so a worker that fixes the bug can be checked by a test.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The module of the fixture. The bug is that `subtract` adds. */
const FIXTURE_MATH = `export function add(a, b) {
\treturn a + b;
}

export function subtract(a, b) {
\treturn a + b;
}
`;

/** The test of the fixture. The second test fails before the fix. */
const FIXTURE_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";

import { add, subtract } from "../src/math.mjs";

test("add adds two numbers", () => {
\tassert.equal(add(2, 3), 5);
});

test("subtract subtracts two numbers", () => {
\tassert.equal(subtract(5, 3), 2);
});
`;

/**
 * Build the fixture repository.
 *
 * The repository holds one commit on the branch `main`, so a worker that
 * works in an isolated worktree can be compared with `main`.
 *
 * The fixture lives under the trial directory of the project, so the report
 * can name it with a path that is relative to the project.
 */
export function makeFixture(root: string): string {
	const dir = mkdtempSync(join(root, "fixture-"));
	mkdirSync(join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, "test"), { recursive: true });
	writeFileSync(join(dir, "src", "math.mjs"), FIXTURE_MATH, "utf8");
	writeFileSync(join(dir, "test", "math.test.mjs"), FIXTURE_TEST, "utf8");
	writeFileSync(join(dir, "README.md"), "# trial fixture\n", "utf8");
	spawnSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
	spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
	spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	spawnSync("git", ["add", "-A"], { cwd: dir });
	spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
	return dir;
}
