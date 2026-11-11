/**
 * The recommendation of the worker eval.
 *
 * The module ranks the cells of one task type. The functions are pure, so
 * a test calls them without a process and without a pane.
 *
 * The recommendation is a report over one benchmark run. It is not a policy
 * engine. A human approves a change of the default configuration.
 */

import type { ReportCell, TaskType } from "./types.ts";

/** The recommendation for one task type. */
export interface Recommendation {
	/** The cell that the run favors. It is null when no cell is eligible. */
	recommended: ReportCell | null;
	/** The second cell of the ranking. It is null when no second cell exists. */
	fallback: ReportCell | null;
	/** The reason of the recommendation. */
	reason: string;
}

/** The least number of valid runs of an eligible cell. */
export const MIN_VALID_RUNS = 3;

/** The least share of valid runs of an eligible cell. */
export const MIN_VALID_SHARE = 0.8;

/**
 * Check that a cell is eligible.
 *
 * A cell is eligible when it holds at least three valid runs and when at
 * least 80 percent of its runs are valid. The function returns the reason
 * of a refusal, or null when the cell is eligible.
 */
export function ineligibleReason(cell: ReportCell): string | null {
	if (cell.valid < MIN_VALID_RUNS) {
		return `the cell ${cell.model}, effort ${cell.effort} holds ${cell.valid} valid runs and needs ${MIN_VALID_RUNS}`;
	}
	if (cell.runs === 0 || cell.valid / cell.runs < MIN_VALID_SHARE) {
		const share = cell.runs === 0 ? 0 : cell.valid / cell.runs;
		return `the cell ${cell.model}, effort ${cell.effort} holds a valid share of ${share.toFixed(2)} and needs ${MIN_VALID_SHARE}`;
	}
	return null;
}

/**
 * Compare two cells of the ranking.
 *
 * The cells are compared by the success rate, then by the number of
 * measured usages, then by the cost, then by the median time. A cell with
 * an incomplete cost comes after a cell with a complete cost. A cell
 * without a median time comes after a cell with a median time.
 */
function compareCells(a: ReportCell, b: ReportCell): number {
	if (a.successRate !== b.successRate) return b.successRate - a.successRate;
	if (a.usageMeasured !== b.usageMeasured) return b.usageMeasured - a.usageMeasured;
	if (a.costComplete !== b.costComplete) return a.costComplete ? -1 : 1;
	if (a.costKnownSum !== b.costKnownSum) return a.costKnownSum - b.costKnownSum;
	const aWall = a.medianWallMs;
	const bWall = b.medianWallMs;
	if (aWall !== bWall) {
		if (aWall === null) return 1;
		if (bWall === null) return -1;
		return aWall - bWall;
	}
	return a.effort.localeCompare(b.effort);
}

/**
 * Recommend one configuration for a task type.
 *
 * The function keeps the cells of the task type that are eligible and
 * ranks them. The first cell is the recommendation and the second cell is
 * the fallback. The reason names the condition that failed when no cell is
 * eligible.
 */
export function recommend(cells: ReportCell[], taskType: TaskType): Recommendation {
	const ofType = cells.filter((cell) => cell.taskType === taskType);
	const eligible = ofType.filter((cell) => ineligibleReason(cell) === null);
	if (eligible.length === 0) {
		return { recommended: null, fallback: null, reason: noEligibleReason(ofType) };
	}
	const ranked = [...eligible].sort(compareCells);
	const recommended = ranked[0];
	const fallback = ranked.length > 1 ? ranked[1] : null;
	return { recommended, fallback, reason: eligibleReason(recommended) };
}

/**
 * The reason that names the condition that no cell met.
 *
 * The function names the limit that every cell of the task type failed.
 */
function noEligibleReason(ofType: ReportCell[]): string {
	if (ofType.length === 0) return "The run holds no cell of the task type";
	const tooFew = ofType.filter((cell) => cell.valid < MIN_VALID_RUNS);
	if (tooFew.length === ofType.length) {
		return `No cell of the task type holds ${MIN_VALID_RUNS} valid runs`;
	}
	return `No cell of the task type holds a valid share of ${MIN_VALID_SHARE}`;
}

/**
 * The reason of a recommendation.
 *
 * The reason names the evidence of the recommended cell. It names the
 * passed runs, the median time and the number of measured usages.
 */
function eligibleReason(cell: ReportCell): string {
	const time =
		cell.medianWallMs === null ? "no median time" : `median ${(cell.medianWallMs / 1000).toFixed(1)} s`;
	return (
		`${cell.pass}/${cell.valid} valid runs passed, ${time}, ` +
		`${cell.usageMeasured} runs with a measured usage`
	);
}
