/**
 * The report of the worker eval.
 *
 * The module groups the records of one run into cells. A cell holds the
 * runs of one task type, one model and one effort level. The functions are
 * pure, so a test calls them without a process and without a pane.
 *
 * A blocked run is not a failure. It stays out of the denominator of the
 * success rate, and the cell keeps it in the count of blocked runs.
 */

import type { ExperimentRecord, ReportCell, ReportFile } from "./types.ts";

/** The key of one group of records. */
function cellKey(record: ExperimentRecord): string {
	return `${record.taskType}\u0000${record.configuration.model}\u0000${record.configuration.effort}`;
}

/**
 * The median of a list of numbers.
 *
 * The median of an odd count is the middle value. The median of an even
 * count is the mean of the two middle values, rounded to the nearest
 * integer. The function returns null when the list holds no value.
 */
export function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[middle];
	return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** The state of the usage of a record, when the record holds a usage. */
function usageState(record: ExperimentRecord): "measured" | "partial" | "unknown" {
	if (record.usage === null) return "unknown";
	return record.usage.state;
}

/**
 * Build the cells of a set of records.
 *
 * A cell groups the records by the task type, the model and the effort.
 * The cells come in the order of the task type, then of the model, then of
 * the effort.
 */
export function buildCells(records: ExperimentRecord[]): ReportCell[] {
	const groups = new Map<string, ExperimentRecord[]>();
	for (const record of records) {
		const key = cellKey(record);
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [record]);
		else group.push(record);
	}
	const cells: ReportCell[] = [];
	for (const group of groups.values()) {
		cells.push(buildCell(group));
	}
	cells.sort((a, b) => {
		if (a.taskType !== b.taskType) return a.taskType.localeCompare(b.taskType);
		if (a.model !== b.model) return a.model.localeCompare(b.model);
		return a.effort.localeCompare(b.effort);
	});
	return cells;
}

/**
 * Build the cell of one group of records.
 *
 * The success rate divides the passed runs by the valid runs. A blocked run
 * is not valid, so it stays out of the denominator. The cost of a cell is
 * complete only when every run holds a measured usage with a number.
 */
function buildCell(records: ExperimentRecord[]): ReportCell {
	const first = records[0];
	let pass = 0;
	let fail = 0;
	let blocked = 0;
	let usageMeasured = 0;
	let usagePartial = 0;
	let usageUnknown = 0;
	let costKnownSum = 0;
	let costComplete = true;
	const wallMs: number[] = [];
	const turns: number[] = [];
	for (const record of records) {
		const verdict = record.verification.verdict;
		if (verdict === "PASS") pass += 1;
		else if (verdict === "FAIL") fail += 1;
		else blocked += 1;
		const state = usageState(record);
		if (state === "measured") usageMeasured += 1;
		else if (state === "partial") usagePartial += 1;
		else usageUnknown += 1;
		const cost = record.usage?.cost;
		if (typeof cost === "number") costKnownSum += cost;
		else costComplete = false;
		if (state !== "measured") costComplete = false;
		if (record.execution.wallMs !== null) wallMs.push(record.execution.wallMs);
		if (record.execution.turns !== null) turns.push(record.execution.turns);
	}
	const valid = pass + fail;
	return {
		taskType: first.taskType,
		model: first.configuration.model,
		effort: first.configuration.effort,
		runs: records.length,
		pass,
		fail,
		blocked,
		valid,
		successRate: valid === 0 ? 0 : pass / valid,
		usageMeasured,
		usagePartial,
		usageUnknown,
		medianWallMs: median(wallMs),
		medianTurns: median(turns),
		costKnownSum,
		costComplete,
	};
}

/**
 * Build the report of one run.
 *
 * The report holds the cells of the records and the name of the run.
 */
export function buildReport(
	records: ExperimentRecord[],
	runId: string,
	datasetVersion: string,
	commit: string,
): ReportFile {
	return {
		schemaVersion: 1,
		runId,
		datasetVersion,
		commit,
		cells: buildCells(records),
	};
}
