/**
 * The text of the report of the worker eval.
 *
 * The module renders the cells of a report as a table for the terminal and
 * as a Markdown document for `docs/trials`. The functions are pure, so a
 * test calls them without a process and without a pane.
 */

import type { ReportCell, ReportFile } from "./types.ts";

/** The text of a value that the report does not know. */
export const UNKNOWN_VALUE = "-";

/** The columns of the table of the cells. */
const COLUMNS = [
	"task",
	"model",
	"effort",
	"runs",
	"pass",
	"fail",
	"blocked",
	"valid",
	"success",
	"median",
	"cost",
];

/**
 * The success rate of a cell as a percent with one decimal.
 *
 * The function returns a string, so a cell of 0 passes gives `0.0%`.
 */
function successText(cell: ReportCell): string {
	return `${(cell.successRate * 100).toFixed(1)}%`;
}

/**
 * The median time of a cell as seconds with one decimal.
 *
 * The function returns `-` when the cell holds no median time.
 */
function medianText(cell: ReportCell): string {
	if (cell.medianWallMs === null) return UNKNOWN_VALUE;
	return `${(cell.medianWallMs / 1000).toFixed(1)} s`;
}

/**
 * The cost of a cell with four decimals.
 *
 * The function returns `-` when the cost of the cell is not complete. A
 * partial sum is not a total, so the table shows no number in that case.
 */
function costText(cell: ReportCell): string {
	if (!cell.costComplete) return UNKNOWN_VALUE;
	return cell.costKnownSum.toFixed(4);
}

/**
 * The values of one cell, in the order of the columns.
 */
function rowValues(cell: ReportCell): string[] {
	return [
		cell.taskType,
		cell.model,
		cell.effort,
		String(cell.runs),
		String(cell.pass),
		String(cell.fail),
		String(cell.blocked),
		String(cell.valid),
		successText(cell),
		medianText(cell),
		costText(cell),
	];
}

/**
 * The cells in the order of the table.
 *
 * The cells come in the order of the success rate, descending. The model
 * and the effort break a tie, so the order of the table never changes.
 */
function rankedCells(cells: ReportCell[]): ReportCell[] {
	return [...cells].sort((a, b) => {
		if (a.successRate !== b.successRate) return b.successRate - a.successRate;
		if (a.model !== b.model) return a.model.localeCompare(b.model);
		return a.effort.localeCompare(b.effort);
	});
}

/**
 * The table of the cells, as plain text.
 *
 * The function gives one header line, one line of dashes and one line per
 * cell. The columns are padded, so the numbers line up.
 */
export function formatTable(cells: ReportCell[]): string {
	const rows = [COLUMNS, ...rankedCells(cells).map(rowValues)];
	const widths = COLUMNS.map((_, index) => Math.max(...rows.map((row) => (row[index] ?? "").length)));
	const lines = rows.map((row) =>
		row
			.map((value, index) => value.padEnd(widths[index]))
			.join("  ")
			.trimEnd(),
	);
	const header = lines[0];
	const dashes = widths.map((width) => "-".repeat(width)).join("  ");
	return [header, dashes, ...lines.slice(1)].join("\n");
}

/**
 * The table of the cells, as Markdown.
 *
 * The function gives the header of the table and one line per cell.
 */
function markdownTable(cells: ReportCell[]): string[] {
	const lines = [
		"| Task | Model | Effort | Runs | Pass | Fail | Blocked | Valid | Success | Median | Cost |",
		"|---|---|---|---|---|---|---|---|---|---|---|",
	];
	for (const cell of rankedCells(cells)) {
		lines.push(
			`| ${cell.taskType} | ${cell.model} | ${cell.effort} | ${cell.runs} | ${cell.pass} | ${cell.fail} | ` +
				`${cell.blocked} | ${cell.valid} | ${successText(cell)} | ${medianText(cell)} | ${costText(cell)} |`,
		);
	}
	return lines;
}

/**
 * The summary of one run, as a Markdown document.
 *
 * The document holds the name of the run, the cells, the environment and a
 * note about the blocked runs.
 */
export function formatSummary(file: ReportFile, environment: Record<string, string>): string {
	const lines: string[] = [];
	lines.push(`# Worker eval ${file.runId}`);
	lines.push("");
	lines.push(`- Run: ${file.runId}`);
	lines.push(`- Dataset version: ${file.datasetVersion}`);
	lines.push(`- Commit: ${file.commit}`);
	lines.push("");
	lines.push("## Cells");
	lines.push("");
	lines.push(...markdownTable(file.cells));
	lines.push("");
	lines.push("## Environment");
	lines.push("");
	lines.push("| Item | Value |");
	lines.push("|---|---|");
	for (const [name, value] of Object.entries(environment)) {
		lines.push(`| ${name} | ${value} |`);
	}
	lines.push("");
	lines.push("A blocked run is not a failure. It stays out of the denominator of the success rate.");
	lines.push("");
	return lines.join("\n");
}
