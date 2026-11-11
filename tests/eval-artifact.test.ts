import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
	listRecords,
	packageVersion,
	readCommit,
	readManifest,
	readRecord,
	recordPath,
	resumeDecision,
	writeManifest,
	writeRecord,
} from "../tooling/eval/artifact.ts";
import type { ExperimentRecord, PlanCell, RunManifest } from "../tooling/eval/types.ts";

/** The root of the repository. */
const ROOT = join(import.meta.dirname, "..");

/** The directories that the tests create. */
const TEMP_DIRS: string[] = [];

/** A temporary directory that the test removes. */
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "eval-artifact-test-"));
	TEMP_DIRS.push(dir);
	return dir;
}

after(() => {
	for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/**
 * Build a record of one experiment.
 *
 * The fields of the record override the fields of the default record. A
 * field that the caller does not give holds its default.
 */
function buildRecord(fields: Record<string, unknown> = {}): ExperimentRecord {
	return {
		schemaVersion: 1,
		experimentId: "exp-0001",
		runId: "eval-2026-11-11-1",
		taskId: "bugfix-001",
		taskType: "bugfix",
		fixtureChecksum: "sha256:aaa",
		promptHash: "sha256:bbb",
		datasetVersion: "2026-11-11.1",
		configuration: {
			model: "omniroute/minimax/MiniMax-M3.1-Flash",
			effort: "medium",
			packageVersion: "0.1.0",
			commit: "abc1234",
			dirty: false,
		},
		timing: { startedAt: 1762800000000, finishedAt: 1762800042000 },
		execution: {
			started: true,
			outcome: "completed",
			jobId: "wz-mvhrdqg1-1",
			status: "completed",
			error: null,
			stop: null,
			turns: 14,
			wallMs: 42000,
			transcript: null,
		},
		verification: {
			verdict: "PASS",
			reason: "",
			command: ["node", "--test", "test/math.test.mjs"],
			exitCode: 0,
			started: true,
			timedOut: false,
			durationMs: 3120,
			restoredPaths: ["test/math.test.mjs"],
			outputTail: "ok",
		},
		usage: null,
		resultText: "done",
		...fields,
	} as ExperimentRecord;
}

/** Build a cell of the plan. */
function buildCell(fields: Record<string, unknown> = {}): PlanCell {
	return {
		experimentId: "exp-0001",
		taskId: "bugfix-001",
		taskType: "bugfix",
		model: "omniroute/minimax/MiniMax-M3.1-Flash",
		effort: "medium",
		fixtureChecksum: "sha256:aaa",
		promptHash: "sha256:bbb",
		...fields,
	} as PlanCell;
}

/** Build the manifest of one run. */
function buildManifest(): RunManifest {
	return {
		schemaVersion: 1,
		runId: "eval-2026-11-11-1",
		createdAt: 1762800000000,
		datasetVersion: "2026-11-11.1",
		packageVersion: "0.1.0",
		commit: "abc1234",
		dirty: false,
		environment: { node: "22.20.0" },
		models: ["omniroute/minimax/MiniMax-M3.1-Flash"],
		efforts: ["medium"],
		pilot: true,
		taskCount: 1,
	};
}

test("a record survives a write and a read", () => {
	const dir = tempDir();
	const record = buildRecord();
	writeRecord(dir, record);
	const read = readRecord(dir, "exp-0001");
	assert.deepEqual(read, record);
});

test("the path of a record holds the id of the experiment", () => {
	const dir = tempDir();
	assert.equal(recordPath(dir, "exp-0007"), join(dir, "exp-0007.json"));
});

test("a write leaves no temporary file", () => {
	const dir = tempDir();
	writeRecord(dir, buildRecord());
	assert.deepEqual(readdirSync(dir), ["exp-0001.json"]);
});

test("the list of records skips a temporary file and an invalid file", () => {
	const dir = tempDir();
	writeRecord(dir, buildRecord());
	writeFileSync(join(dir, "exp-0002.json.tmp-999"), "{}", "utf8");
	writeFileSync(join(dir, "exp-0003.json"), "{not json", "utf8");
	writeFileSync(join(dir, "notes.txt"), "hello", "utf8");
	const records = listRecords(dir);
	assert.deepEqual(
		records.map((record) => record.experimentId),
		["exp-0001"],
	);
});

test("the list of records sorts by the id of the experiment", () => {
	const dir = tempDir();
	writeRecord(dir, buildRecord({ experimentId: "exp-0003" }));
	writeRecord(dir, buildRecord({ experimentId: "exp-0001" }));
	writeRecord(dir, buildRecord({ experimentId: "exp-0002" }));
	const records = listRecords(dir);
	assert.deepEqual(
		records.map((record) => record.experimentId),
		["exp-0001", "exp-0002", "exp-0003"],
	);
});

test("a record with a wrong schema version gives null", () => {
	const dir = tempDir();
	writeRecord(dir, buildRecord({ schemaVersion: 2 }));
	assert.equal(readRecord(dir, "exp-0001"), null);
});

test("a record without an identifier gives null", () => {
	const dir = tempDir();
	writeRecord(dir, buildRecord({ experimentId: 7 }));
	assert.equal(readRecord(dir, "7"), null);
});

test("the resume runs an experiment without a record", () => {
	assert.equal(resumeDecision(buildCell(), null), "run");
});

test("the resume skips a finished record with the same checksum", () => {
	const record = buildRecord();
	assert.equal(resumeDecision(buildCell(), record), "skip");
});

test("the resume runs an experiment with another checksum", () => {
	const record = buildRecord({ fixtureChecksum: "sha256:ccc" });
	assert.equal(resumeDecision(buildCell(), record), "run");
});

test("the resume runs a record without a finish time", () => {
	const record = buildRecord({ timing: { startedAt: 1762800000000, finishedAt: null } });
	assert.equal(resumeDecision(buildCell(), record), "run");
});

test("the manifest survives a write and a read", () => {
	const dir = tempDir();
	const manifest = buildManifest();
	writeManifest(dir, manifest);
	assert.deepEqual(readManifest(dir), manifest);
});

test("the manifest of a missing file gives null", () => {
	assert.equal(readManifest(tempDir()), null);
});

test("the commit of this repository is a hexadecimal string", () => {
	const commit = readCommit(ROOT);
	assert.ok(commit !== null, "the call of git failed");
	assert.match(commit, /^[0-9a-f]+$/);
});

test("the version of the package of the root is 0.1.0", () => {
	assert.equal(packageVersion(ROOT), "0.1.0");
});

test("the version of a missing package gives unknown", () => {
	assert.equal(packageVersion(tempDir()), "unknown");
});
