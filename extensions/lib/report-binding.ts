/**
 * The binding of a report to its instruction cycle.
 *
 * A report proves a task state only for the cycle that produced it. A report
 * of an earlier cycle cannot finish newer work. The owner steers a worker
 * into a new cycle, and the report of the old cycle stays on the disk.
 *
 * The filter is a pure function of the reports and the start of the cycle, so
 * a test can check it without a pane.
 */

import type { WorkerReport } from "./report-model.ts";

/**
 * The reports of a run that belong to the current instruction cycle.
 *
 * A report belongs to the cycle when its write time is at or after the start
 * of the cycle. A report of an earlier cycle stays in the file as evidence,
 * but it never decides the state of the run.
 *
 * A cycle without a start time keeps every report. The transcript holds no
 * evidence of the start then, so the rule cannot refuse a report.
 *
 * A report without a write time belongs to the cycle. The report file adds
 * the write time, so a report without it comes from an older file or from
 * another writer.
 */
export function reportsOfCycle(reports: WorkerReport[], cycleStartAt: number | null): WorkerReport[] {
	if (cycleStartAt === null) return reports;
	return reports.filter((report) => report.at === undefined || report.at >= cycleStartAt);
}
