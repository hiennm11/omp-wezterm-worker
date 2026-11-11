import assert from "node:assert/strict";
import { test } from "node:test";

import { formatSummary, formatTable } from "../tooling/eval/format.ts";
import { buildCells, buildReport } from "../tooling/eval/report.ts";
import type { ExperimentRecord, ReportFile } from "../tooling/eval/types.ts";

/** The fields that a record overrides. */
type Overrides = Record<string, unknown>;

/**
 * Build a record of one experiment.
 *
 * The fields of the record override the fields of the default record. A
 * field that the caller does not give holds its default.
 */
function buildRecord(overrides: Overrides = {}): ExperimentRecord {
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
		usage: {
			state: "measured",
			totals: null,
			cost: 0.0123,
			note: null,
		},
		resultText: "done",
		...overrides,
	} as ExperimentRecord;
}

/** Build a record with a given verdict. */
function recordVerdict(verdict: "PASS" | "FAIL" | "BLOCKED"): ExperimentRecord {
	return buildRecord({
		experimentId: `exp-${verdict}`,
		verification: {
			verdict,
			reason: "",
			command: [],
			exitCode: verdict === "PASS" ? 0 : 1,
			started: true,
			timedOut: false,
			durationMs: 100,
			restoredPaths: [],
			outputTail: "",
		},
	});
}

/** Build a record with a given usage state and cost. */
function recordUsage(
	state: "measured" | "partial" | "unknown",
	cost: number | null,
	id: string,
): ExperimentRecord {
	return buildRecord({
		experimentId: id,
		usage: { state, totals: null, cost, note: null },
	});
}

/** Build a report of one set of records. */
function buildFile(records: ExperimentRecord[]): ReportFile {
	return buildReport(records, "eval-2026-11-11-1", "2026-11-11.1", "abc1234");
}

test("a blocked run stays out of the valid runs and out of the success rate", () => {
	const records = [
		recordVerdict("PASS"),
		recordVerdict("PASS"),
		recordVerdict("FAIL"),
		recordVerdict("BLOCKED"),
	];
	const cells = buildCells(records);
	assert.equal(cells.length, 1);
	assert.equal(cells[0].runs, 4);
	assert.equal(cells[0].pass, 2);
	assert.equal(cells[0].fail, 1);
	assert.equal(cells[0].blocked, 1);
	assert.equal(cells[0].valid, 3);
	assert.equal(cells[0].successRate, 2 / 3);
});

test("a cell without a valid run has a success rate of zero", () => {
	const cells = buildCells([recordVerdict("BLOCKED")]);
	assert.equal(cells[0].valid, 0);
	assert.equal(cells[0].successRate, 0);
});

test("the three usage counts cover measured, partial and unknown", () => {
	const records = [
		recordUsage("measured", 0.01, "exp-0001"),
		recordUsage("measured", 0.02, "exp-0002"),
		recordUsage("partial", 0.03, "exp-0003"),
		buildRecord({ experimentId: "exp-0004", usage: null }),
		recordUsage("unknown", null, "exp-0005"),
	];
	const cells = buildCells(records);
	assert.equal(cells[0].usageMeasured, 2);
	assert.equal(cells[0].usagePartial, 1);
	assert.equal(cells[0].usageUnknown, 2);
});

test("an incomplete cost gives costComplete false and still sums the known costs", () => {
	const records = [recordUsage("measured", 0.01, "exp-0001"), recordUsage("partial", 0.02, "exp-0002")];
	const cells = buildCells(records);
	assert.equal(cells[0].costComplete, false);
	assert.ok(Math.abs(cells[0].costKnownSum - 0.03) < 1e-9);
});

test("a complete cost gives costComplete true", () => {
	const records = [recordUsage("measured", 0.01, "exp-0001"), recordUsage("measured", 0.02, "exp-0002")];
	const cells = buildCells(records);
	assert.equal(cells[0].costComplete, true);
	assert.ok(Math.abs(cells[0].costKnownSum - 0.03) < 1e-9);
});

test("the median of an odd count is the middle value", () => {
	const records = [
		buildRecord({
			experimentId: "exp-0001",
			execution: { ...buildRecord().execution, wallMs: 3000, turns: 1 },
		}),
		buildRecord({
			experimentId: "exp-0002",
			execution: { ...buildRecord().execution, wallMs: 1000, turns: 3 },
		}),
		buildRecord({
			experimentId: "exp-0003",
			execution: { ...buildRecord().execution, wallMs: 2000, turns: 2 },
		}),
	];
	const cells = buildCells(records);
	assert.equal(cells[0].medianWallMs, 2000);
	assert.equal(cells[0].medianTurns, 2);
});

test("the median of an even count is the mean of the two middle values", () => {
	const records = [
		buildRecord({
			experimentId: "exp-0001",
			execution: { ...buildRecord().execution, wallMs: 1000, turns: 2 },
		}),
		buildRecord({
			experimentId: "exp-0002",
			execution: { ...buildRecord().execution, wallMs: 2001, turns: 4 },
		}),
		buildRecord({
			experimentId: "exp-0003",
			execution: { ...buildRecord().execution, wallMs: 3000, turns: 6 },
		}),
		buildRecord({
			experimentId: "exp-0004",
			execution: { ...buildRecord().execution, wallMs: 4000, turns: 8 },
		}),
	];
	const cells = buildCells(records);
	assert.equal(cells[0].medianWallMs, 2501);
	assert.equal(cells[0].medianTurns, 5);
});

test("a run without a wall time gives a median of null", () => {
	const records = [buildRecord({ execution: { ...buildRecord().execution, wallMs: null, turns: null } })];
	const cells = buildCells(records);
	assert.equal(cells[0].medianWallMs, null);
	assert.equal(cells[0].medianTurns, null);
});

test("the cells are grouped by task type, model and effort", () => {
	const records = [
		buildRecord({ experimentId: "exp-0001" }),
		buildRecord({ experimentId: "exp-0002" }),
		buildRecord({
			experimentId: "exp-0003",
			configuration: { ...buildRecord().configuration, model: "omniroute/cc/claude-opus-5-5" },
		}),
		buildRecord({
			experimentId: "exp-0004",
			configuration: { ...buildRecord().configuration, effort: "high" },
		}),
		buildRecord({
			experimentId: "exp-0005",
			taskType: "testing",
			configuration: { ...buildRecord().configuration, effort: "low" },
		}),
	];
	const cells = buildCells(records);
	assert.equal(cells.length, 4);
	assert.deepEqual(
		cells.map((cell) => `${cell.taskType}/${cell.model}/${cell.effort}`),
		[
			"bugfix/omniroute/cc/claude-opus-5-5/medium",
			"bugfix/omniroute/minimax/MiniMax-M3.1-Flash/high",
			"bugfix/omniroute/minimax/MiniMax-M3.1-Flash/medium",
			"testing/omniroute/minimax/MiniMax-M3.1-Flash/low",
		],
	);
	assert.equal(cells[2].runs, 2);
});

test("the cells of two task types come in the order of the task type", () => {
	const records = [
		buildRecord({ experimentId: "exp-0001", taskType: "testing" }),
		buildRecord({ experimentId: "exp-0002", taskType: "bugfix" }),
	];
	const cells = buildCells(records);
	assert.deepEqual(
		cells.map((cell) => cell.taskType),
		["bugfix", "testing"],
	);
});

test("an empty list of records gives no cell", () => {
	assert.deepEqual(buildCells([]), []);
});

test("the report holds the run, the dataset version and the commit", () => {
	const file = buildFile([buildRecord()]);
	assert.equal(file.schemaVersion, 1);
	assert.equal(file.runId, "eval-2026-11-11-1");
	assert.equal(file.datasetVersion, "2026-11-11.1");
	assert.equal(file.commit, "abc1234");
	assert.equal(file.cells.length, 1);
});

test("the table shows a dash for an unknown cost and for a null median", () => {
	const records = [
		buildRecord({
			experimentId: "exp-0001",
			usage: { state: "partial", totals: null, cost: 0.01, note: null },
			execution: { ...buildRecord().execution, wallMs: null },
		}),
	];
	const cells = buildCells(records);
	const columns = formatTable(cells)
		.split("\n")[2]
		.split(/\s{2,}/);
	assert.equal(columns.at(-2), "-", "the median column");
	assert.equal(columns.at(-1), "-", "the cost column");
});

test("the table shows the cost with four decimals when the cost is complete", () => {
	const cells = buildCells([recordUsage("measured", 0.012345, "exp-0001")]);
	const table = formatTable(cells);
	assert.ok(table.includes("0.0123"));
});

test("the table shows the success rate with one decimal percent", () => {
	const cells = buildCells([recordVerdict("PASS"), recordVerdict("FAIL")]);
	const table = formatTable(cells);
	assert.ok(table.includes("50.0%"));
});

test("the table holds the cells in the order of the success rate", () => {
	const records = [
		buildRecord({
			experimentId: "exp-0001",
			configuration: { ...buildRecord().configuration, model: "omniroute/cc/claude-haiku-5-5" },
		}),
		buildRecord({
			experimentId: "exp-0002",
			configuration: { ...buildRecord().configuration, model: "omniroute/cc/claude-opus-5-5" },
			verification: {
				...buildRecord().verification,
				verdict: "FAIL",
				exitCode: 1,
			},
		}),
	];
	const table = formatTable(buildCells(records));
	const lines = table.split("\n");
	assert.ok(lines[2].includes("omniroute/cc/claude-haiku-5-5"));
	assert.ok(lines[3].includes("omniroute/cc/claude-opus-5-5"));
});

test("the summary holds the run, the dataset version and the commit", () => {
	const file = buildFile([buildRecord()]);
	const summary = formatSummary(file, { node: "v22.19.0" });
	assert.ok(summary.includes("# Worker eval eval-2026-11-11-1"));
	assert.ok(summary.includes("2026-11-11.1"));
	assert.ok(summary.includes("abc1234"));
	assert.ok(summary.includes("v22.19.0"));
	assert.ok(summary.includes("A blocked run is not a failure."));
});
