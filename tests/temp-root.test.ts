/**
 * The temp root of a test run.
 *
 * The module `tests/temp-root.ts` gives the test process a temp root of its
 * own. The root sits in the temp folder of the machine. The module removes
 * the root when the process exits.
 *
 * The test proves the two facts that the root gives to a test. A test that
 * asks for a temp directory gets one inside the root. The root is gone when
 * the process that made it exits.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

/** The root of the repository that holds the module under test. */
const ROOT = join(import.meta.dirname, "..");

/** The code of the child that creates a temp directory. */
const PROBE = [
	'import { mkdtempSync } from "node:fs";',
	'import { tmpdir } from "node:os";',
	'import { join } from "node:path";',
	'process.stdout.write(mkdtempSync(join(tmpdir(), "wt-probe-")));',
].join("\n");

test("a test that imports the temp root writes its temp files under the temp root", () => {
	const child = spawnSync(
		process.execPath,
		["--import", "./tests/temp-root.ts", "--input-type=module", "--eval", PROBE],
		{ cwd: ROOT, encoding: "utf8" },
	);
	const path = child.stdout.trim();
	try {
		assert.equal(child.status, 0, `the child did not start: ${child.stderr}`);
		assert.ok(path, "the child printed no path");
		const root = dirname(path);
		assert.ok(basename(root).startsWith("wt-run-"), `the path is not under a temp root: ${path}`);
		assert.equal(existsSync(root), false, `the temp root stayed behind: ${root}`);
	} finally {
		if (path) rmSync(path, { recursive: true, force: true });
	}
});
