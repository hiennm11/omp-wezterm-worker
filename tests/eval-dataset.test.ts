import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { fixtureChecksum, loadDataset, promptHash } from "../tooling/eval/dataset.ts";
import type { DatasetIssue } from "../tooling/eval/types.ts";

/** The directories that the tests create. */
const TEMP_DIRS: string[] = [];

/** A temporary directory that the test removes. */
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "eval-dataset-test-"));
	TEMP_DIRS.push(dir);
	return dir;
}

after(() => {
	for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/** Write a file and create its directory. */
function writeFile(root: string, path: string, text: string): void {
	const full = join(root, path);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, text, "utf8");
}

/**
 * Build a dataset with one task.
 *
 * The fields of the task override the fields of the default task. A field
 * that the caller does not give holds its default.
 */
function buildDataset(taskFields: Record<string, unknown> = {}): string {
	const root = tempDir();
	writeFile(root, "dataset.json", JSON.stringify({ schemaVersion: 1, version: "2026-11-11.1" }));
	writeFile(root, "bugfix/bugfix-001/task.md", "Repair the module.\n");
	writeFile(root, "bugfix/bugfix-001/fixture/src/math.mjs", "export const a = 1;\n");
	const task = {
		taskType: "bugfix",
		verify: {
			command: ["node", "--test", "test/math.test.mjs"],
			expectBefore: "fail",
			protectedPaths: ["test/"],
		},
		...taskFields,
	};
	writeFile(root, "bugfix/bugfix-001/task.json", JSON.stringify(task, null, 2));
	return root;
}

/** The problems of a dataset that the loader reports. */
function issuesOf(root: string): DatasetIssue[] {
	const loaded = loadDataset(root);
	if (loaded.ok) return [];
	return loaded.issues;
}

test("the checksum of a fixture is stable for the same bytes", () => {
	const first = buildDataset();
	const second = buildDataset();
	const firstChecksum = fixtureChecksum(join(first, "bugfix/bugfix-001/fixture"));
	const secondChecksum = fixtureChecksum(join(second, "bugfix/bugfix-001/fixture"));
	assert.equal(firstChecksum, secondChecksum);
	assert.match(firstChecksum, /^sha256:[0-9a-f]{64}$/);
});

test("the checksum of a fixture changes when one byte changes", () => {
	const root = buildDataset();
	const fixture = join(root, "bugfix/bugfix-001/fixture");
	const before = fixtureChecksum(fixture);
	writeFile(fixture, "src/math.mjs", "export const a = 2;\n");
	assert.notEqual(fixtureChecksum(fixture), before);
});

test("the loader refuses a malformed task and names the field", () => {
	const root = buildDataset({ verify: { command: [], expectBefore: "fail" } });
	const issues = issuesOf(root);
	assert.equal(issues.length, 1);
	assert.equal(issues[0].path, "bugfix/bugfix-001");
	assert.equal(issues[0].field, "verify.command");
});

test("the loader refuses a task with an unknown task type", () => {
	const root = buildDataset({ taskType: "architecture" });
	const issues = issuesOf(root);
	assert.equal(issues.length, 1);
	assert.equal(issues[0].field, "taskType");
});

test("the loader refuses a task with an unknown expectation", () => {
	const root = buildDataset({
		verify: { command: ["node", "--test", "test/math.test.mjs"], expectBefore: "maybe" },
	});
	const issues = issuesOf(root);
	assert.equal(issues.length, 1);
	assert.equal(issues[0].field, "verify.expectBefore");
});

test("the loader applies the defaults of the absent fields", () => {
	const root = buildDataset();
	const loaded = loadDataset(root);
	assert.equal(loaded.ok, true);
	if (!loaded.ok) return;
	const task = loaded.dataset.tasks[0];
	assert.equal(task.workerTimeoutMs, 900000);
	assert.equal(task.verify.timeoutMs, 60000);
	assert.deepEqual(task.verify.protectedPaths, ["test/"]);
});

test("the loader applies the default of the absent protected paths", () => {
	const root = buildDataset({
		verify: { command: ["node", "--test", "test/math.test.mjs"], expectBefore: "fail" },
	});
	const loaded = loadDataset(root);
	assert.equal(loaded.ok, true);
	if (!loaded.ok) return;
	assert.deepEqual(loaded.dataset.tasks[0].verify.protectedPaths, []);
});

test("the hash of a prompt is stable", () => {
	const root = buildDataset();
	const first = promptHash(join(root, "bugfix/bugfix-001/task.md"));
	const second = promptHash(join(root, "bugfix/bugfix-001/task.md"));
	assert.equal(first, second);
	assert.match(first, /^sha256:[0-9a-f]{64}$/);
});

test("the loader reads every task of the dataset", () => {
	const root = buildDataset();
	writeFile(root, "implementation/implementation-001/task.md", "Add the export.\n");
	writeFile(root, "implementation/implementation-001/fixture/src/greet.mjs", "export const b = 2;\n");
	writeFile(
		root,
		"implementation/implementation-001/task.json",
		JSON.stringify({
			taskType: "implementation",
			verify: { command: ["node", "--test", "test/greet.test.mjs"], expectBefore: "fail" },
		}),
	);
	const loaded = loadDataset(root);
	assert.equal(loaded.ok, true);
	if (!loaded.ok) return;
	assert.equal(loaded.dataset.tasks.length, 2);
	assert.deepEqual(
		loaded.dataset.tasks.map((task) => task.taskId),
		["bugfix-001", "implementation-001"],
	);
});
