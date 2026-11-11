import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";

import { loadDataset } from "../tooling/eval/dataset.ts";

/** The root of the repository. */
const ROOT = join(import.meta.dirname, "..");

/** The command line of the worker eval. */
const CLI = join("tooling", "eval", "cli.ts");

/** The dataset of the benchmark. */
const DATASET = join("tooling", "eval", "datasets");

/** The model that the test uses. */
const MODEL = "omniroute/minimax/MiniMax-M3.1-Flash";

/** The efforts that the test uses. */
const EFFORTS = ["medium", "high"];

/** The directories that the test creates. */
const TEMP_DIRS: string[] = [];

/** A temporary directory that the test removes. */
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "eval-plan-test-"));
	TEMP_DIRS.push(dir);
	return dir;
}

after(() => {
	for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/** The number of tasks of the dataset. */
function taskCount(): number {
	const loaded = loadDataset(join(ROOT, DATASET));
	assert.ok(loaded.ok, "the dataset of the repository does not load");
	return loaded.dataset.tasks.length;
}

/** The result of one run of the command line. */
interface Run {
	status: number | null;
	stdout: string;
	stderr: string;
}

/** Run the command line with the repository as the working directory. */
function cli(args: string[]): Run {
	const result = spawnSync(process.execPath, [CLI, ...args], {
		cwd: ROOT,
		encoding: "utf8",
		windowsHide: true,
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The arguments of the command `plan` for an output directory. */
function planArgs(out: string): string[] {
	return [
		"plan",
		"--dataset",
		DATASET,
		"--models",
		MODEL,
		"--efforts",
		EFFORTS.join(","),
		"--pilot",
		"--out",
		out,
		"--allow-dirty",
	];
}

test("the command plan writes the plan file and the manifest file", () => {
	const out = tempDir();
	const result = cli(planArgs(out));
	assert.equal(result.status, 0, result.stderr);
	assert.ok(existsSync(join(out, "plan.json")), "the command wrote no plan file");
	assert.ok(existsSync(join(out, "manifest.json")), "the command wrote no manifest file");
});

test("the manifest holds the run, the matrix and the state of the work tree", () => {
	const out = tempDir();
	const result = cli(planArgs(out));
	assert.equal(result.status, 0, result.stderr);
	const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Record<string, unknown>;
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.runId, basename(out));
	assert.equal(manifest.taskCount, taskCount());
	assert.equal(manifest.pilot, true);
	assert.deepEqual(manifest.models, [MODEL]);
	assert.deepEqual(manifest.efforts, EFFORTS);
	assert.equal(typeof manifest.dirty, "boolean");
	assert.equal(typeof manifest.commit, "string");
	assert.equal(typeof manifest.createdAt, "number");
	assert.equal(typeof manifest.datasetVersion, "string");
	assert.equal(typeof manifest.packageVersion, "string");
});

test("the command plan with a dry run writes no file", () => {
	const out = tempDir();
	const result = cli([...planArgs(out), "--dry-run"]);
	assert.equal(result.status, 0, result.stderr);
	assert.ok(!existsSync(join(out, "plan.json")), "the command wrote a plan file");
	assert.ok(!existsSync(join(out, "manifest.json")), "the command wrote a manifest file");
});

test("the command plan without a model exits with the code of a usage error", () => {
	const out = tempDir();
	const result = cli(["plan", "--dataset", DATASET, "--efforts", EFFORTS.join(","), "--out", out]);
	assert.equal(result.status, 2);
	assert.ok(!existsSync(join(out, "plan.json")), "the command wrote a plan file");
	assert.ok(!existsSync(join(out, "manifest.json")), "the command wrote a manifest file");
});
