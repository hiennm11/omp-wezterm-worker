/**
 * The report of the prune.
 *
 * The report names every worker that needs a decision. It skips a worker
 * that the prune cannot act on, and it counts the skipped workers.
 *
 * The functions here are pure functions of the list of the results. A test
 * can check them without a repository and without a pane.
 */

import type { PruneResult } from "./prune.ts";

/** The workers that the report names and the workers that it skips. */
export interface PruneReport {
	/** The results of the workers that the report names. */
	listed: PruneResult[];
	/** The number of the workers that hold no worktree. */
	noWorktree: number;
	/** The number of the workers whose worktree is gone and that hold no branch. */
	goneWorktree: number;
}

/**
 * Split the results into the workers that the report names and the counts of
 * the workers that it skips.
 *
 * A worker is named when the prune can act on it or when it refused for a
 * reason that the owner can fix. A worker that holds no worktree and a
 * worker whose worktree is gone and that holds no branch are skipped.
 */
export function planPruneReport(results: PruneResult[]): PruneReport {
	const listed: PruneResult[] = [];
	let noWorktree = 0;
	let goneWorktree = 0;
	for (const result of results) {
		if (result.skip === "no-worktree") {
			noWorktree += 1;
			continue;
		}
		if (result.skip === "gone-worktree") {
			goneWorktree += 1;
			continue;
		}
		listed.push(result);
	}
	return { listed, noWorktree, goneWorktree };
}

/**
 * The lines that count the workers that the report skips.
 *
 * The function returns no line when no worker is skipped.
 */
export function pruneSummaryLines(report: PruneReport): string[] {
	const lines: string[] = [];
	if (report.noWorktree > 0) {
		const subject = report.noWorktree === 1 ? "1 worker has" : `${report.noWorktree} workers have`;
		lines.push(`${subject} no worktree and ${report.noWorktree === 1 ? "is" : "are"} skipped.`);
	}
	if (report.goneWorktree > 0) {
		const subject = report.goneWorktree === 1 ? "1 worker has" : `${report.goneWorktree} workers have`;
		const verb = report.goneWorktree === 1 ? "holds" : "hold";
		const pronoun = report.goneWorktree === 1 ? "It is" : "They are";
		lines.push(`${subject} a worktree that is gone from the disk and ${verb} no branch. ${pronoun} skipped.`);
	}
	return lines;
}
