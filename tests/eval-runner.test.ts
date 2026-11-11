import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { listRecords, writeRecord } from "../tooling/eval/artifact.ts";
import { loadDataset } from "../tooling/eval/dataset.ts";
import { runExperiment, runPlan } from "../tooling/eval/runner.ts";
import type { ExperimentRecord } from "../tooling/eval/types.ts";
import { runVerifier } from "../tooling/eval/verifier.ts";
import {
	bugfixTask,
	cell,
	DATASET_DIR,
	environment,
	FakeHost,
	GOOD_MODULE,
	paths,
	plan,
	removeTempDirs,
	tempDir,
	usageReport,
} from "./eval-runner-helpers.ts";

after(() => {
	removeTempDirs();
});

test("a good run gives a PASS and writes the record", async () => {
	const runDir = tempDir();
	const host = new FakeHost();
	host.work = (fixtureDir) => {
		writeFileSync(join(fixtureDir, "src", "math.mjs"), GOOD_MODULE, "utf8");
	};
	const record = await runExperiment(host, bugfixTask(), cell(), paths(runDir), environment());
	assert.equal(record.verification.verdict, "PASS");
	assert.equal(record.execution.outcome, "completed");
	assert.equal(record.execution.started, true);
	assert.equal(record.resultText, "the worker fixed the module");
	const written = listRecords(join(runDir, "experiments"));
	assert.equal(written.length, 1);
	assert.equal(written[0].verification.verdict, "PASS");
});

test("the usage of the record is the usage of the status row", async () => {
	const runDir = tempDir();
	const host = new FakeHost();
	host.work = (fixtureDir) => {
		writeFileSync(join(fixtureDir, "src", "math.mjs"), GOOD_MODULE, "utf8");
	};
	const record = await runExperiment(host, bugfixTask(), cell(), paths(runDir), environment());
	assert.deepEqual(record.usage, host.statusRow.usage);
});

test("an unknown cost stays null", async () => {
	const runDir = tempDir();
	const host = new FakeHost();
	host.work = (fixtureDir) => {
		writeFileSync(join(fixtureDir, "src", "math.mjs"), GOOD_MODULE, "utf8");
	};
	host.statusRow = { ...host.statusRow, usage: usageReport(null) };
	const record = await runExperiment(host, bugfixTask(), cell(), paths(runDir), environment());
	assert.equal(record.usage?.cost, null);
	assert.equal(record.usage?.state, "unknown");
});

test("a bad run gives a FAIL and writes the record", async () => {
	const runDir = tempDir();
	const host = new FakeHost();
	host.work = () => {};
	const record = await runExperiment(host, bugfixTask(), cell(), paths(runDir), environment());
	assert.equal(record.verification.verdict, "FAIL");
	assert.equal(record.verification.exitCode, 1);
	const written = listRecords(join(runDir, "experiments"));
	assert.equal(written.length, 1);
	assert.equal(written[0].verification.verdict, "FAIL");
});

test("a refused spawn gives a BLOCKED and no start", async () => {
	const runDir = tempDir();
	const host = new FakeHost();
	host.refuse = true;
	const record = await runExperiment(host, bugfixTask(), cell(), paths(runDir), environment());
	assert.equal(record.verification.verdict, "BLOCKED");
	assert.equal(record.execution.started, false);
	assert.equal(record.execution.outcome, "not_started");
});

test("a deleted test file comes back after the restore", async () => {
	const runDir = tempDir();
	const host = new FakeHost();
	host.work = (fixtureDir) => {
		rmSync(join(fixtureDir, "test", "math.test.mjs"), { force: true });
	};
	const record = await runExperiment(host, bugfixTask(), cell(), paths(runDir), environment());
	assert.deepEqual(record.verification.restoredPaths, ["test/math.test.mjs"]);
	assert.equal(record.verification.verdict, "FAIL");
	const restored = readFileSync(join(runDir, "fixtures", "exp-0001", "test", "math.test.mjs"), "utf8");
	assert.equal(restored.includes("subtract subtracts two numbers"), true);
});

test("a deleted test file cannot pass when the worker fixed the bug", async () => {
	const runDir = tempDir();
	const host = new FakeHost();
	host.work = (fixtureDir) => {
		writeFileSync(join(fixtureDir, "src", "math.mjs"), GOOD_MODULE, "utf8");
		rmSync(join(fixtureDir, "test", "math.test.mjs"), { force: true });
	};
	const record = await runExperiment(host, bugfixTask(), cell(), paths(runDir), environment());
	assert.equal(record.verification.verdict, "PASS");
	assert.deepEqual(record.verification.restoredPaths, ["test/math.test.mjs"]);
});

test("a finished record with the same checksum is skipped", async () => {
	const runDir = tempDir();
	const host = new FakeHost();
	const task = bugfixTask();
	const target = cell({ fixtureChecksum: task.fixtureChecksum });
	const existing: ExperimentRecord = {
		schemaVersion: 1,
		experimentId: target.experimentId,
		runId: "eval-test",
		taskId: target.taskId,
		taskType: target.taskType,
		fixtureChecksum: target.fixtureChecksum,
		promptHash: target.promptHash,
		datasetVersion: "2026-11-11.1",
		configuration: {
			model: target.model,
			effort: target.effort,
			packageVersion: "0.1.0",
			commit: "abc1234",
			dirty: false,
		},
		timing: { startedAt: 1, finishedAt: 2 },
		execution: {
			started: true,
			outcome: "completed",
			jobId: "wz-test-1",
			status: "completed",
			error: null,
			stop: null,
			turns: 1,
			wallMs: 1,
			transcript: null,
		},
		verification: {
			verdict: "PASS",
			reason: "",
			command: ["node", "--test", "test/math.test.mjs"],
			exitCode: 0,
			started: true,
			timedOut: false,
			durationMs: 1,
			restoredPaths: [],
			outputTail: "",
		},
		usage: null,
		resultText: "done",
	};
	writeRecord(join(runDir, "experiments"), existing);
	const records = await runPlan(host, plan([target]), [task], paths(runDir), environment());
	assert.deepEqual(records, []);
	assert.equal(host.calls.includes("wezterm_spawn_worker"), false);
});

test("the plan runs the cells in plan order", async () => {
	const runDir = tempDir();
	const host = new FakeHost();
	host.work = (fixtureDir) => {
		writeFileSync(join(fixtureDir, "src", "math.mjs"), GOOD_MODULE, "utf8");
	};
	const task = bugfixTask();
	const first = cell({ experimentId: "exp-0002", fixtureChecksum: task.fixtureChecksum });
	const second = cell({ experimentId: "exp-0001", fixtureChecksum: task.fixtureChecksum });
	const records = await runPlan(host, plan([first, second]), [task], paths(runDir), environment());
	assert.deepEqual(
		records.map((record) => record.experimentId),
		["exp-0002", "exp-0001"],
	);
});

test("the plan continues after a failure of the machinery", async () => {
	const runDir = tempDir();
	const host = new FakeHost();
	const task = bugfixTask();
	const first = cell({ experimentId: "exp-0001", fixtureChecksum: task.fixtureChecksum });
	const second = cell({ experimentId: "exp-0002", fixtureChecksum: task.fixtureChecksum });
	host.call = async (name: string, args: Record<string, unknown>) => {
		if (name === "wezterm_spawn_worker" && args.cwd !== undefined) {
			throw new Error("the pane did not open");
		}
		return {
			content: [{ type: "text", text: "" }],
			details: { workerId: "wz-test-1", paneId: "1" },
		};
	};
	const records = await runPlan(host, plan([first, second]), [task], paths(runDir), environment());
	assert.equal(records.length, 2);
	assert.equal(records[0].verification.verdict, "BLOCKED");
});

test("the run directory holds the fixture copy of the experiment", async () => {
	const runDir = tempDir();
	const host = new FakeHost();
	host.work = (fixtureDir) => {
		writeFileSync(join(fixtureDir, "src", "math.mjs"), GOOD_MODULE, "utf8");
	};
	await runExperiment(host, bugfixTask(), cell(), paths(runDir), environment());
	const copied = join(runDir, "fixtures", "exp-0001", "src", "math.mjs");
	assert.equal(existsSync(copied), true);
	assert.equal(readFileSync(copied, "utf8"), GOOD_MODULE);
});

test("a run directory holds a copy of the fixture of the pilot", () => {
	const runDir = tempDir();
	const copy = join(runDir, "dataset");
	mkdirSync(copy, { recursive: true });
	cpSync(DATASET_DIR, copy, { recursive: true });
	const loaded = loadDataset(copy);
	assert.ok(loaded.ok, "the copy of the dataset must load");
	const source = loadDataset(DATASET_DIR);
	assert.ok(source.ok, "the dataset of the repository must load");
	assert.deepEqual(
		loaded.dataset.tasks.map((task) => task.taskId),
		source.dataset.tasks.map((task) => task.taskId),
	);
	assert.deepEqual(
		loaded.dataset.tasks.map((task) => task.fixtureChecksum),
		source.dataset.tasks.map((task) => task.fixtureChecksum),
	);
});

test("the verifier fails a broken fixture inside a test runner", () => {
	/* A test runner sets the variable NODE_TEST_CONTEXT. A command that
	   starts `node --test` refuses to run when it inherits that variable, and
	   it exits with the code 0. The verifier must remove the variable. */
	const fixture = join(tempDir(), "fixture");
	cpSync(join(DATASET_DIR, "bugfix", "bugfix-001", "fixture"), fixture, { recursive: true });
	const result = runVerifier(["node", "--test", "test/math.test.mjs"], fixture, 60000);
	assert.equal(result.started, true);
	assert.equal(result.exitCode, 1);
});
